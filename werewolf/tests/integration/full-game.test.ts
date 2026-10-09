/**
 * Full-game integration test (plan task 16):
 * lobby -> night -> dawn -> day_discussion -> voting -> finished in a 6-seat
 * all-LLM room (seeded mock LLM). Asserts event-log legality (no private
 * information on public events; correct visibleTo on private events; the
 * task-14 per-seat leak guard) and determinism (same engine seed + same mock
 * seed => byte-identical event logs).
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/orchestrator';
import { EngineState } from '../../src/engine/state';
import { createSeededRng } from '../../src/engine/deck';
import { SeatAdapter } from '../../src/agents/seat-adapter';
import { HostAgent } from '../../src/agents/host-agent';
import { assertNoLeak, eventsVisibleTo } from '../../src/engine/visibility';
import { createSeededMockLlm } from '../helpers/mock-llm';
import type { Event, GamePhase, RoleConfig, SeatState } from '../../src/engine/types';

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0,
};

const ROLES: RoleConfig[] = [
  { id: 'werewolf', name: '狼人', faction: 'villain', min: 2, max: 2, night: { order: 1, action: 'target_player', targets: 1, maxTargets: 1, promptTemplateId: 'werewolf_night' } },
  { id: 'seer', name: '预言家', faction: 'villager', min: 1, max: 1, night: { order: 2, action: 'observe', targets: 1, maxTargets: 1, promptTemplateId: 'seer_night' } },
  { id: 'witch', name: '女巫', faction: 'villager', min: 1, max: 1, night: { order: 3, action: 'protect', targets: 1, maxTargets: 1, promptTemplateId: 'witch_night' } },
  { id: 'hunter', name: '猎人', faction: 'villager', min: 1, max: 1, day: { action: 'speak', promptTemplateId: 'hunter_day' } },
  { id: 'villager', name: '村民', faction: 'villager', min: 1, max: 8, day: { action: 'speak', promptTemplateId: 'villager_day' } },
];

function makeSeats(): SeatState[] {
  return [
    { seatId: 's0', kind: 'agent', name: 'Agent 0' },
    { seatId: 's1', kind: 'agent', name: 'Agent 1' },
    { seatId: 's2', kind: 'agent', name: 'Agent 2' },
    { seatId: 's3', kind: 'agent', name: 'Agent 3' },
    { seatId: 's4', kind: 'agent', name: 'Agent 4' },
    { seatId: 's5', kind: 'agent', name: 'Agent 5' },
  ];
}

/** Deterministic fake clock: each call advances 100 ms. */
function makeClock(): () => number {
  let t = 1000000;
  return () => (t += 100);
}

async function playGame(engineSeed: number, mockSeed: number): Promise<{ state: EngineState; winner: 'villain' | 'villager' }> {
  const now = makeClock();
  const state = new EngineState(makeSeats(), TIMINGS, createSeededRng(engineSeed), now);
  const adapter = new SeatAdapter(state, createSeededMockLlm(mockSeed), async () => ({ action: 'pass' as const, targets: [] as string[] }));
  const host = new HostAgent(createSeededMockLlm(mockSeed), state);
  const orch = new Orchestrator(state, adapter, host, () => {}, now);
  await orch.start(ROLES);
  const winner = await orch.runUntilDone();
  return { state, winner: winner.winner };
}

const PRIVATE_TYPES = new Set(['role_assigned', 'seer_result', 'witch_save', 'night_pass', 'werewolf_kill']);

describe('full-game integration (task 16)', () => {
  it('plays lobby->night->dawn->day_discussion->voting->finished with a legal log', async () => {
    const { state, winner } = await playGame(42, 777);
    expect(['villain', 'villager'], 'a faction won').toContain(winner);
    expect(state.phase).toBe('finished');
    expect(state.winner).toBe(winner);

    const log: Event[] = state.log;
    const phases = log.filter((e) => e.type === 'phase_change').map((e) => e.payload.phase as string);
    for (const p of ['night', 'dawn', 'day_discussion', 'voting', 'finished']) {
      expect(phases, 'phase ' + p + ' was entered').toContain(p);
    }

    // Legality: no private event type may ever be public.
    for (const e of log) {
      if (e.visibleTo === null) {
        expect(PRIVATE_TYPES.has(e.type), 'public ' + e.type + ' event must not carry private information').toBe(false);
      } else if (e.type === 'role_assigned') {
        const seat = state.seats.find((s) => s.seatId === e.payload.seatId) as SeatState;
        const isWolf = (seat.role as { faction: string }).faction === 'villain';
        const wolves = state.seats.filter((s) => s.role?.faction === 'villain').map((s) => s.seatId);
        expect(e.visibleTo, 'role_assigned visibility for ' + e.payload.seatId).toEqual(isWolf ? wolves : [seat.seatId]);
      } else if (e.type === 'werewolf_kill') {
        const wolves = state.seats.filter((s) => s.role?.faction === 'villain').map((s) => s.seatId);
        expect(e.visibleTo, 'werewolf_kill must be visible to the wolf pack only').toEqual(wolves);
      }
    }

    // Task-14 per-seat guard: no seat ever sees an event it is not bound for.
    for (const seat of state.seats) {
      const role = state.roleConfigForSeat(seat.seatId) as RoleConfig;
      assertNoLeak(eventsVisibleTo(log, seat.seatId), seat.seatId, role);
    }

    // The game actually killed someone (no stalemate).
    expect(log.some((e) => e.type === 'voted_out' || e.type === 'player_died'), 'a death occurred').toBe(true);
  });

  it('is deterministic: identical seeds give byte-identical event logs', async () => {
    const a = await playGame(42, 777);
    const b = await playGame(42, 777);
    expect(a.winner).toBe(b.winner);
    expect(JSON.stringify(a.state.log), 'event log must be byte-identical across runs').toBe(JSON.stringify(b.state.log));
  });
});
