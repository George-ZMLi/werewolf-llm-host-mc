import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from './orchestrator';
import { EngineState } from './engine/state';
import { createSeededRng } from './engine/deck';
import type { Event, LlmClient, RoleConfig, SeatState } from './engine/types';
import { SeatAdapter } from './agents/seat-adapter';
import { HostAgent } from './agents/host-agent';

const config: RoleConfig[] = [
  {
    id: 'werewolf',
    name: '狼人',
    faction: 'villain',
    min: 2,
    max: 2,
    night: { order: 1, action: 'target_player', targets: 1, maxTargets: 1, promptTemplateId: 'werewolf_night' },
  },
  {
    id: 'seer',
    name: '预言家',
    faction: 'villager',
    min: 1,
    max: 1,
    night: { order: 2, action: 'observe', targets: 1, maxTargets: 1, promptTemplateId: 'seer_night' },
  },
  { id: 'villager', name: '村民', faction: 'villager', min: 2, max: 2 },
];

function makeSeats(): SeatState[] {
  return ['a', 'b', 'c', 'd', 'e'].map((id) => ({ seatId: id, kind: 'agent' as const, name: id.toUpperCase() }));
}

const humanStub = () => Promise.reject(new Error('no humans in this room'));

/** Deterministic scripted LLM: wolves hunt the first alive villager; everyone else passes. */
function scriptedClient(state: EngineState, delayMs = 0): LlmClient {
  return async (prompt: string) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const isWolf = prompt.includes('Your role: 狼人');
    const isSeer = prompt.includes('Your role: 预言家');
    if (state.phase === 'night' && isWolf) {
      // the wolf kill is a once-per-game skill (engine skillUsed flag); any
      // living non-wolf (villager faction, seer included) is a valid target
      const victim = state.seats.find((s) => s.role?.alive && s.role.faction === 'villager');
      if (victim) return JSON.stringify({ action: 'target_player', targets: [victim.seatId] });
    }
    if (state.phase === 'voting') {
      const wolves = state.seats.filter((s) => s.role?.alive && s.role.faction === 'villain');
      if (isWolf) {
        // feint: wolves vote for the first living non-wolf
        const feint = state.seats.find((s) => s.role?.alive && s.role.faction === 'villager');
        if (feint) return JSON.stringify({ action: 'target_player', targets: [feint.seatId] });
      } else if (wolves.length > 0) {
        // seer (asymmetric info) votes the first living wolf, villagers the last
        const target = isSeer ? wolves[0] : wolves[wolves.length - 1];
        return JSON.stringify({ action: 'target_player', targets: [target.seatId] });
      }
    }
    return JSON.stringify({ action: 'pass', targets: [] });
  };
}

describe('Orchestrator.runUntilDone', () => {
  it('runs a full game with all-LLM seats and reaches a winner', async () => {
    const state = new EngineState(makeSeats(), { lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0 }, createSeededRng(7), () => 1000000);
    const client = scriptedClient(state);
    const adapter = new SeatAdapter(state, client, humanStub);
    const host = new HostAgent(vi.fn().mockResolvedValue('主持人：夜幕降临。') as unknown as LlmClient, state);
    const events: Event[] = [];
    const onEvent = vi.fn((e: Event) => events.push(e));
    const orch = new Orchestrator(state, adapter, host, onEvent, () => 1000000);

    await orch.start(config);
    expect(state.phase).toBe('night');
    const result = await orch.runUntilDone();

    expect(result.winner).toBe('villain');
    expect(state.phase).toBe('finished');
    expect(orch.isRunning).toBe(false);
    // every engine event is forwarded to onEvent exactly once
    expect(events).toHaveLength(state.log.length);
    expect(events.some((e) => e.type === 'game_dealt')).toBe(true);
    // the wolf kill is a once-per-game skill: both wolves kill the first
    // villager on night 1, then the villagers lynch the wolves out over two votes
    expect(state.log.filter((e) => e.type === 'werewolf_kill')).toHaveLength(2);
  });

  it('stops immediately when checkWin returns done', async () => {
    const state = new EngineState(makeSeats(), { lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0 }, createSeededRng(7), () => 1000000);
    state.deal(config);
    state.startNight();
    state.advancePhase(); // night -> dawn
    for (const s of state.seats) if (s.role?.faction === 'villager') s.role.alive = false; // all non-wolves wiped (seer included)

    const client = scriptedClient(state);
    const adapter = new SeatAdapter(state, client, humanStub);
    const host = new HostAgent(vi.fn().mockResolvedValue('x') as unknown as LlmClient, state);
    const onEvent = vi.fn();
    const orch = new Orchestrator(state, adapter, host, onEvent, () => 1000000);

    const result = await orch.runUntilDone();
    expect(result.winner).toBe('villain');
    expect(state.phase).toBe('finished');
    // no day turns happened: the loop stopped at the win check
    expect(state.log.some((e) => e.type === 'player_speech')).toBe(false);
  });

  it('enforces phase budgets and advances even if a turn is slow', async () => {
    const state = new EngineState(makeSeats(), { lobby: 0, night: 50, dawn: 50, day_discussion: 50, voting: 50, finished: 0 }, createSeededRng(7), () => Date.now());
    const client = scriptedClient(state, 80); // every turn outlives the 50ms budget
    const adapter = new SeatAdapter(state, client, humanStub);
    const host = new HostAgent(vi.fn().mockResolvedValue('主持人：请发言。') as unknown as LlmClient, state);
    const onEvent = vi.fn();
    const orch = new Orchestrator(state, adapter, host, onEvent, () => Date.now());

    await orch.start(config);
    const result = await orch.runUntilDone();

    // the game still finishes: budgets force-advance phases with safe defaults
    expect(result.winner).toBe('villain');
    expect(orch.isRunning).toBe(false);
    // most turns were skipped: far fewer speeches than a full discussion would produce
    const speeches = state.log.filter((e) => e.type === 'player_speech').length;
    expect(speeches).toBeLessThan(5 * 2);
  });
});
