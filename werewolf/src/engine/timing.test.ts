import { describe, expect, it } from 'vitest';
import { createSeededRng } from './deck';
import { EngineState } from './state';
import type { GamePhase, SeatState } from './types';
import { PhaseTimer } from './timing';

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0,
  night: 100,
  dawn: 10,
  day_discussion: 50,
  voting: 30,
  finished: 0,
};

function makeState(): EngineState {
  const seats: SeatState[] = [
    { seatId: 's0', kind: 'agent', name: 'A' },
    { seatId: 's1', kind: 'agent', name: 'B' },
  ];
  const state = new EngineState(seats, TIMINGS, createSeededRng(1), () => 0);
  state.phase = 'night';
  state.phaseStartedAt = 0;
  state.currentPhaseBudgetMs = TIMINGS.night;
  return state;
}

describe('PhaseTimer', () => {
  it('fires onExpiry exactly once when remainingMs hits 0', () => {
    let t = 0;
    const state = makeState();
    const timer = new PhaseTimer(state, TIMINGS, () => t);
    expect(timer.remainingMs()).toBe(100);
    let count = 0;
    timer.onExpiry(() => {
      count += 1;
    });
    t = 60;
    expect(timer.tick()).toBe(false);
    expect(count).toBe(0);
    t = 99;
    expect(timer.tick()).toBe(false);
    expect(count).toBe(0);
    t = 100;
    expect(timer.tick()).toBe(true);
    expect(count).toBe(1);
  });

  it('does not fire onExpiry a second time after the first fire', () => {
    let t = 0;
    const state = makeState();
    const timer = new PhaseTimer(state, TIMINGS, () => t);
    let count = 0;
    timer.onExpiry(() => {
      count += 1;
    });
    t = 100;
    timer.tick();
    expect(count).toBe(1);
    // re-registering after the fire is a no-op
    timer.onExpiry(() => {
      count += 1;
    });
    expect(timer.tick()).toBe(false);
    t = 500;
    timer.tick();
    expect(count).toBe(1);
    expect(timer.isFired()).toBe(true);
  });

  it('fires synchronously when the phase is already overdue at registration', () => {
    let t = 200;
    const state = makeState();
    const timer = new PhaseTimer(state, TIMINGS, () => t);
    let count = 0;
    timer.onExpiry(() => {
      count += 1;
    });
    expect(count).toBe(1);
    expect(timer.isFired()).toBe(true);
  });

  it('remainingMs clamps at 0 and follows the injected clock', () => {
    let t = 0;
    const state = makeState();
    const timer = new PhaseTimer(state, TIMINGS, () => t);
    t = 150;
    expect(timer.remainingMs()).toBe(0);
    t = 1000;
    expect(timer.remainingMs()).toBe(0);
  });

  it('returns softWarnMs from the config, not a computed value', () => {
    let t = 0;
    const state = makeState();
    const timer = new PhaseTimer(state, { budgetMs: TIMINGS, softWarnMs: { night: 20000, voting: 15000 } }, () => t);
    expect(timer.softWarnMs()).toBe(20000);
    state.phase = 'voting';
    expect(timer.softWarnMs()).toBe(15000);
    state.phase = 'finished';
    expect(timer.softWarnMs()).toBe(0);
  });
});
