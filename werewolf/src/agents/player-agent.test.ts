import { describe, it, expect, vi } from 'vitest';
import { PlayerAgent } from './player-agent';
import { EngineState } from '../engine/state';
import { createSeededRng } from '../engine/deck';
import type { LlmClient, RoleConfig, SeatState } from '../engine/types';
import standardRolesJson from '../../data/roles-standard.json';

const roles = standardRolesJson as unknown as RoleConfig[];

function makeState() {
  const seats: SeatState[] = [
    { seatId: 'a', kind: 'agent', name: 'A', role: { roleId: 'seer', faction: 'villager', alive: true } },
    { seatId: 'b', kind: 'agent', name: 'B', role: { roleId: 'werewolf', faction: 'villain', alive: true } },
    { seatId: 'c', kind: 'agent', name: 'C', role: { roleId: 'villager', faction: 'villager', alive: true } },
  ];
  const state = new EngineState(
    seats,
    { lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0 },
    createSeededRng(7),
    () => 1000000,
  );
  state.roleConfigs = roles;
  return state;
}

describe('PlayerAgent.onNightAction', () => {
  it('passes only events the seat is allowed to see to the LLM', async () => {
    const state = makeState();
    state.startNight();
    state.recordEvent('seer_result', { marker: 'SEER_PRIVATE', targetId: 'b' }, ['a']);
    state.recordEvent('werewolf_kill', { marker: 'WOLF_PRIVATE', targetId: 'c' }, ['b']);
    const mock = vi.fn().mockResolvedValue('{"action":"observe","targets":["b"],"confidence":0.9}');
    const agent = new PlayerAgent('a', mock as unknown as LlmClient, state);
    await agent.onNightAction();
    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).toContain('SEER_PRIVATE'); // own private event visible
    expect(prompt).not.toContain('WOLF_PRIVATE'); // other seat's private event hidden
    expect(prompt).toContain('phase_change'); // public events visible
  });

  it('returns a valid AgentAction for target_player roles', async () => {
    const state = makeState();
    state.startNight();
    const mock = vi.fn().mockResolvedValue('{"action":"target_player","targets":["c"]}');
    const agent = new PlayerAgent('b', mock as unknown as LlmClient, state);
    const action = await agent.onNightAction();
    expect(action.action).toBe('target_player');
    expect(action.targets).toEqual(['c']);
  });

  it('falls back to safe default on LLM failure', async () => {
    const state = makeState();
    state.startNight();
    const mock = vi.fn().mockRejectedValue(new Error('llm down'));
    const agent = new PlayerAgent('c', mock as unknown as LlmClient, state); // villager: no kill right
    const action = await agent.onNightAction();
    expect(action.action).toBe('pass');
    expect(action.targets).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1); // rejected client -> immediate fallback
  });
});

describe('PlayerAgent.onDaySpeech', () => {
  it('returns the LLM in-character remark', async () => {
    const state = makeState();
    state.startDayDiscussion();
    const mock = vi.fn().mockResolvedValue('我认为3号是狼人。');
    const agent = new PlayerAgent('a', mock as unknown as LlmClient, state);
    expect(await agent.onDaySpeech()).toBe('我认为3号是狼人。');
  });

  it('returns a fallback line when the LLM fails', async () => {
    const state = makeState();
    state.startDayDiscussion();
    const mock = vi.fn().mockRejectedValue(new Error('boom'));
    const agent = new PlayerAgent('a', mock as unknown as LlmClient, state);
    const speech = await agent.onDaySpeech();
    expect(speech.length).toBeGreaterThan(0);
  });
});
