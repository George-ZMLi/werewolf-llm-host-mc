import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../engine/deck';
import { EngineState } from '../engine/state';
import type { AgentPromptContext, Event, GamePhase, RoleConfig, SeatState } from '../engine/types';
import { buildDayPrompt, buildHostPrompt, buildNightPrompt } from './prompts';

const WOLF: RoleConfig = {
  id: 'werewolf',
  name: '狼人',
  faction: 'villain',
  min: 2,
  max: 2,
  night: { order: 1, action: 'target_player', targets: 1, maxTargets: 1, promptTemplateId: 'wolf_night' },
};

const VILLAGER: RoleConfig = {
  id: 'villager',
  name: '村民',
  faction: 'villager',
  min: 0,
  max: 6,
};

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0,
  night: 50,
  dawn: 10,
  day_discussion: 50,
  voting: 30,
  finished: 0,
};

const SEATS: SeatState[] = [
  { seatId: 's0', kind: 'agent', name: 'Alice' },
  { seatId: 's1', kind: 'agent', name: 'Bob' },
  { seatId: 's2', kind: 'agent', name: 'Cara' },
];

function makeEvents(): { pub: Event[]; priv: Event[] } {
  const pub: Event[] = [
    { ts: 1, phase: 'lobby', type: 'game_dealt', payload: { seatCount: 3, marker: 'PUBLIC_NOTICE' }, visibleTo: null },
    { ts: 2, phase: 'night', type: 'phase_change', payload: { phase: 'night' }, visibleTo: null },
  ];
  const priv: Event[] = [
    { ts: 3, phase: 'night', type: 'werewolf_kill', payload: { target: 's0', marker: 'SECRET_WOLF_TARGET' }, visibleTo: ['s1'] },
  ];
  return { pub, priv };
}

function makeCtx(selfSeatId: string, role: RoleConfig): AgentPromptContext {
  const { pub, priv } = makeEvents();
  return {
    role,
    publicLog: pub,
    privateLog: priv,
    aliveSeats: SEATS,
    selfSeatId,
  };
}

function makeHostState(): EngineState {
  const state = new EngineState(SEATS, TIMINGS, createSeededRng(1), () => 1000000);
  state.recordEvent('game_dealt', { seatCount: 3 }, null);
  state.recordEvent('phase_change', { phase: 'day_discussion' }, null);
  return state;
}

describe('prompt redaction', () => {
  it('includes only publicLog in a non-werewolf seat prompt', () => {
    const ctx = makeCtx('s0', VILLAGER); // wolf kill is visible to s1 only
    const night = buildNightPrompt(VILLAGER, ctx);
    const day = buildDayPrompt(VILLAGER, ctx);
    for (const p of [night, day]) {
      expect(p).toContain('PUBLIC_NOTICE');
      expect(p).not.toContain('SECRET_WOLF_TARGET');
      expect(p).not.toContain('werewolf_kill');
    }
  });

  it('includes privateLog for a werewolf seat', () => {
    const ctx = makeCtx('s1', WOLF);
    const night = buildNightPrompt(WOLF, ctx);
    expect(night).toContain('SECRET_WOLF_TARGET');
    expect(night).toContain('werewolf_kill');
    expect(night).toContain('PUBLIC_NOTICE');
    expect(night).toContain('wolf_night');
  });

  it('buildDayPrompt splices the persona argument and the public log', () => {
    const ctx = makeCtx('s0', VILLAGER);
    const day = buildDayPrompt(VILLAGER, ctx, 'A calm farmer');
    expect(day).toContain('A calm farmer');
    expect(day).toContain('PUBLIC_NOTICE');
    expect(day).not.toContain('SECRET_WOLF_TARGET');
  });

  it('buildHostPrompt includes the live cadence number and public log only', () => {
    const state = makeHostState();
    const host = buildHostPrompt(state, 'day_discussion', 3);
    expect(host).toContain('3 messages/minute');
    expect(host).toContain('day_discussion');
    expect(host).not.toContain('SECRET_WOLF_TARGET');
  });

  it('never includes a wall-clock timestamp in any prompt', () => {
    const wolfNight = buildNightPrompt(WOLF, makeCtx('s1', WOLF));
    const villagerDay = buildDayPrompt(VILLAGER, makeCtx('s0', VILLAGER), 'p');
    const host = buildHostPrompt(makeHostState(), 'day_discussion', 3);
    for (const p of [wolfNight, villagerDay, host]) {
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(p).not.toMatch(/new Date/);
    }
    // byte-identical across repeated calls (determinism)
    expect(buildNightPrompt(WOLF, makeCtx('s1', WOLF))).toBe(wolfNight);
  });
});
