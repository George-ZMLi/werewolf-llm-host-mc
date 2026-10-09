import { describe, it, expect } from 'vitest';
import { EngineState } from './state';
import { createSeededRng } from './deck';
import type { GamePhase, SeatState } from './types';
import standardRolesJson from '../../data/roles-standard.json';
import type { RoleConfig } from './types';

const roles = standardRolesJson as unknown as RoleConfig[];

function makeSeats(n: number): SeatState[] {
  return Array.from({ length: n }, (_, i) => ({
    seatId: `s${i}`,
    kind: i === 0 ? ('human' as const) : ('agent' as const),
    name: `P${i}`,
  }));
}

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0,
  night: 10000,
  dawn: 5000,
  day_discussion: 30000,
  voting: 15000,
  finished: 0,
};

describe('EngineState phase machine', () => {
  it('transitions lobby→night→dawn→day_discussion→voting→night in order', () => {
    let t = 1_000_000;
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(1), () => t);
    expect(s.phase).toBe('lobby');
    s.startNight();
    expect(s.phase).toBe('night');
    s.startDawn();
    expect(s.phase).toBe('dawn');
    s.startDayDiscussion();
    expect(s.phase).toBe('day_discussion');
    s.startVoting();
    expect(s.phase).toBe('voting');
    s.advancePhase();
    expect(s.phase).toBe('night');
    s.advancePhase();
    expect(s.phase).toBe('dawn');
  });

  it('advancePhase into voting clears the previous ballot (fresh currentVotes)', () => {
    let t = 1_000_000;
    const s = new EngineState(makeSeats(3), TIMINGS, createSeededRng(1), () => t);
    s.startNight();
    s.startDawn();
    s.startDayDiscussion();
    s.startVoting();
    s.currentVotes.set('s0', 's1');
    s.advancePhase(); // voting -> night
    s.advancePhase(); // night -> dawn
    s.advancePhase(); // dawn -> day_discussion
    s.advancePhase(); // day_discussion -> voting
    expect(s.phase).toBe('voting');
    expect(s.currentVotes.size).toBe(0);
  });

  it('startNight resets phaseStartedAt to the injected clock', () => {
    let t = 5000;
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(1), () => t);
    s.startNight();
    expect(s.phaseStartedAt).toBe(5000);
    t = 15000;
    s.startNight();
    expect(s.phaseStartedAt).toBe(15000);
  });

  it('phaseRemainingMs reflects the injected clock, not wall time', () => {
    let t = 1_000_000;
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(1), () => t);
    s.startNight();
    expect(s.phaseRemainingMs()).toBe(10000);
    t = 1_003_000;
    expect(s.phaseRemainingMs()).toBe(7000);
    t = 2_000_000;
    expect(s.phaseRemainingMs()).toBe(0); // clamped at 0, no negative remainders
  });

  it('recordEvent keeps ts as UTC-epoch ms numbers (no Date anywhere)', () => {
    let t = 42;
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(1), () => t);
    s.startNight();
    const e = s.recordEvent('test_event', { a: 1 });
    expect(e.ts).toBe(42);
    expect(typeof e.ts).toBe('number');
    expect(e).not.toHaveProperty('date');
  });
});

describe('EngineState deal', () => {
  it('assigns a role to every seat and marks them alive', () => {
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(42));
    s.deal(roles);
    for (const seat of s.seats) {
      expect(seat.role?.roleId).toBeTruthy();
      expect(seat.role?.alive).toBe(true);
    }
    const counts = new Map<string, number>();
    for (const seat of s.seats) {
      counts.set(seat.role!.roleId, (counts.get(seat.role!.roleId) ?? 0) + 1);
    }
    expect(counts.get('werewolf')).toBe(2);
    expect(counts.get('villager')).toBe(4);
  });

  it('is deterministic: same seed ⇒ same assignment', () => {
    const s1 = new EngineState(makeSeats(9), TIMINGS, createSeededRng(7));
    const s2 = new EngineState(makeSeats(9), TIMINGS, createSeededRng(7));
    s1.deal(roles);
    s2.deal(roles);
    const a = s1.seats.map((s) => s.role!.roleId);
    const b = s2.seats.map((s) => s.role!.roleId);
    expect(a).toEqual(b);
  });

  it('emits role_assigned events with werewolf visibility scoped to wolves only', () => {
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(42));
    s.deal(roles);
    const wolfEvents = s.log.filter(
      (e) => e.type === 'role_assigned' && (e.payload.role as string) === 'werewolf',
    );
    expect(wolfEvents.length).toBe(2);
    const wolfSeatIds = s.seats.filter((x) => x.role?.faction === 'villain').map((x) => x.seatId);
    for (const e of wolfEvents) {
      expect(e.visibleTo).toEqual([...wolfSeatIds]);
    }
    const seerEvent = s.log.find(
      (e) => e.type === 'role_assigned' && (e.payload.role as string) === 'seer',
    );
    expect(seerEvent?.visibleTo).toEqual([s.seatById(seerEvent!.payload.seatId as string)!.seatId]);
  });

  it('throws when the config cannot cover the seat count', () => {
    const s = new EngineState(makeSeats(9), TIMINGS, createSeededRng(1));
    expect(() => s.deal(roles.slice(0, 1))).toThrow();
  });
});
