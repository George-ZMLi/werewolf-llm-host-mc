import { describe, it, expect, vi } from 'vitest';
import { SeatAdapter } from './seat-adapter';
import { EngineState } from '../engine/state';
import { createSeededRng } from '../engine/deck';
import type { AgentAction, LlmClient, RoleConfig, SeatState } from '../engine/types';
import standardRolesJson from '../../data/roles-standard.json';

const roles = standardRolesJson as unknown as RoleConfig[];

function makeState(timings?: Partial<Record<string, number>>) {
  const seats: SeatState[] = [
    { seatId: 'a', kind: 'agent', name: 'A', role: { roleId: 'seer', faction: 'villager', alive: true } },
    { seatId: 'h', kind: 'human', name: 'H', role: { roleId: 'villager', faction: 'villager', alive: true } },
    { seatId: 'd', kind: 'agent', name: 'D', role: { roleId: 'villager', faction: 'villager', alive: false } },
    { seatId: 'host', kind: 'host', name: 'MC' },
  ];
  const state = new EngineState(
    seats,
    { lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0, ...(timings ?? {}) },
    createSeededRng(7),
    () => 1000000,
  );
  state.roleConfigs = roles;
  return state;
}

const humanStub = () => Promise.resolve({ action: 'pass' as const, targets: [] as string[] });

describe('SeatAdapter.runTurn', () => {
  it('routes agent seats to PlayerAgent and submits the decision', async () => {
    const state = makeState();
    state.startNight();
    const client = vi.fn().mockResolvedValue('{"action":"observe","targets":["h"],"confidence":0.8}') as unknown as LlmClient;
    const handler = vi.fn();
    const adapter = new SeatAdapter(state, client, humanStub, handler);
    await adapter.runTurn('a');
    expect(client).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const [seat, action] = handler.mock.calls[0] as [SeatState, AgentAction | string];
    expect(seat.seatId).toBe('a');
    expect(action).toMatchObject({ action: 'observe', targets: ['h'] });
    expect(adapter.submissions.get('a')).toMatchObject({ action: 'observe', targets: ['h'] });
  });

  it('waits for humanSubmit and submits the human action on success', async () => {
    const state = makeState();
    state.startNight();
    const client = vi.fn() as unknown as LlmClient;
    const humanSubmit = vi.fn().mockResolvedValue({ action: 'target_player', targets: ['a'] });
    const handler = vi.fn();
    const adapter = new SeatAdapter(state, client, humanSubmit, handler);
    await adapter.runTurn('h');
    expect(humanSubmit).toHaveBeenCalledWith('h');
    expect(handler).toHaveBeenCalledTimes(1);
    const [seat, action] = handler.mock.calls[0] as [SeatState, AgentAction | string];
    expect(seat.seatId).toBe('h');
    expect(action).toEqual({ action: 'target_player', targets: ['a'] });
  });

  it('auto-submits a safe default if humanSubmit exceeds the phase budget', async () => {
    const state = makeState({ day_discussion: 80 }); // tiny budget
    state.startDayDiscussion();
    const client = vi.fn() as unknown as LlmClient;
    const humanSubmit = vi.fn().mockImplementation(
      () => new Promise<AgentAction | string>((resolve) => setTimeout(() => resolve('迟到的发言'), 400)),
    );
    const handler = vi.fn();
    const adapter = new SeatAdapter(state, client, humanSubmit, handler);
    await adapter.runTurn('h'); // resolves after ~80ms with the safe default
    expect(handler).toHaveBeenCalledTimes(1);
    const [seat, action] = handler.mock.calls[0] as [SeatState, AgentAction | string];
    expect(seat.seatId).toBe('h');
    expect(action).toEqual({ action: 'pass', targets: [] });
    expect(state.log.some((e) => e.type === 'timeout')).toBe(true);
  });

  it('takes no turn for a dead seat', async () => {
    const state = makeState();
    state.startNight();
    const client = vi.fn() as unknown as LlmClient;
    const handler = vi.fn();
    const adapter = new SeatAdapter(state, client, humanStub, handler);
    await adapter.runTurn('d');
    expect(handler).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('rejects turns for host seats', async () => {
    const state = makeState();
    const client = vi.fn() as unknown as LlmClient;
    const adapter = new SeatAdapter(state, client, humanStub);
    await expect(adapter.runTurn('host')).rejects.toThrow(/runHostTurn/);
  });
});

describe('SeatAdapter.runHostTurn', () => {
  it('announces the current phase and checks silence during discussion', async () => {
    const state = makeState();
    state.startDayDiscussion();
    const client = vi.fn().mockResolvedValue('讨论开始。') as unknown as LlmClient;
    const adapter = new SeatAdapter(state, client, humanStub);
    await adapter.runHostTurn();
    expect(state.log.some((e) => e.type === 'host_announcement')).toBe(true);
  });
});
