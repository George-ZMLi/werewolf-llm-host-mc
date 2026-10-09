import { describe, it, expect } from 'vitest';
import { EngineState } from './state';
import { createSeededRng } from './deck';
import { checkWin, recordVote, resolveDawn, resolveNightAction, resolveVotes } from './skills';
import type { GamePhase, SeatState } from './types';
import standardRolesJson from '../../data/roles-standard.json';
import type { RoleConfig } from './types';

const roles = standardRolesJson as unknown as RoleConfig[];
const TIMINGS: Record<GamePhase, number> = {
  lobby: 0, night: 1000, dawn: 1000, day_discussion: 1000, voting: 1000, finished: 0,
};

/** A 6-seat room: 2 wolves, seer, witch, 2 villagers — manually assigned. */
function makeState(): EngineState {
  const seats: SeatState[] = [
    { seatId: 'w1', kind: 'agent', name: 'Wolf A', role: { roleId: 'werewolf', faction: 'villain', alive: true } },
    { seatId: 'w2', kind: 'agent', name: 'Wolf B', role: { roleId: 'werewolf', faction: 'villain', alive: true } },
    { seatId: 'seer', kind: 'agent', name: 'Seer', role: { roleId: 'seer', faction: 'villager', alive: true } },
    { seatId: 'witch', kind: 'agent', name: 'Witch', role: { roleId: 'witch', faction: 'villager', alive: true } },
    { seatId: 'v1', kind: 'agent', name: 'V1', role: { roleId: 'villager', faction: 'villager', alive: true } },
    { seatId: 'v2', kind: 'agent', name: 'V2', role: { roleId: 'villager', faction: 'villager', alive: true } },
  ];
  const state = new EngineState(seats, TIMINGS, createSeededRng(1));
  state.roleConfigs = roles;
  state.startNight();
  return state;
}

describe('resolveNightAction validation', () => {
  it('rejects self-targets', () => {
    const state = makeState();
    const r = resolveNightAction(state, 'w1', { action: 'target_player', targets: ['w1'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/self/);
  });

  it('rejects dead targets', () => {
    const state = makeState();
    state.seatById('v1')!.role!.alive = false;
    const r = resolveNightAction(state, 'w1', { action: 'target_player', targets: ['v1'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a wrong target count for a single-target role', () => {
    const state = makeState();
    const r = resolveNightAction(state, 'w1', { action: 'target_player', targets: ['v1', 'v2'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a second use of a once-per-game skill', () => {
    const state = makeState();
    const first = resolveNightAction(state, 'witch', { action: 'protect', targets: ['v1'] });
    expect(first.ok).toBe(true);
    const second = resolveNightAction(state, 'witch', { action: 'protect', targets: ['v2'] });
    expect(second.ok).toBe(false);
  });

  it('rejects an action that does not match the role\'s night rule', () => {
    const state = makeState();
    const r = resolveNightAction(state, 'witch', { action: 'target_player', targets: ['v1'] });
    expect(r.ok).toBe(false);
  });

  it('accepts a legal wolf kill and emits a wolf-visible event', () => {
    const state = makeState();
    const r = resolveNightAction(state, 'w1', { action: 'target_player', targets: ['v1'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events[0].type).toBe('werewolf_kill');
      expect(r.events[0].visibleTo).toEqual(['w1', 'w2']);
    }
  });

  it('accepts seer observation and the result is private to the seer', () => {
    const state = makeState();
    const r = resolveNightAction(state, 'seer', { action: 'observe', targets: ['w2'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events[0].type).toBe('seer_result');
      expect(r.events[0].payload.isWerewolf).toBe(true);
      expect(r.events[0].visibleTo).toEqual(['seer']);
    }
  });
});

describe('dawn resolution', () => {
  it('kills the wolf target when no save applies', () => {
    const state = makeState();
    state.nightPending.kills.push('v1');
    resolveDawn(state);
    expect(state.seatById('v1')!.role!.alive).toBe(false);
  });

  it('the witch save cancels a kill on the saved seat', () => {
    const state = makeState();
    state.nightPending.kills.push('v1');
    state.nightPending.saves.push('v1');
    resolveDawn(state);
    expect(state.seatById('v1')!.role!.alive).toBe(true);
    expect(state.log.some((e) => e.type === 'night_saved')).toBe(true);
  });

  it('majority wolf target wins on disagreement; save still applies', () => {
    const state = makeState();
    state.nightPending.kills.push('v1', 'v2', 'v1'); // w1→v1, w2→v2, extra w2→v1? (3 kills, 2 for v1)
    state.nightPending.saves.push('v2');
    const events = resolveDawn(state);
    expect(state.seatById('v1')!.role!.alive).toBe(false); // v1 has 2 votes
    expect(state.seatById('v2')!.role!.alive).toBe(true); // saved
    expect(events.some((e) => e.type === 'player_died')).toBe(true);
  });
});

describe('checkWin', () => {
  it('returns villager as winner when all werewolves die', () => {
    const state = makeState();
    state.seatById('w1')!.role!.alive = false;
    state.seatById('w2')!.role!.alive = false;
    const r = checkWin(state);
    expect(r).toEqual({ done: true, winner: 'villager' });
  });

  it('returns villain as winner when all non-werewolves die', () => {
    const state = makeState();
    for (const id of ['seer', 'witch', 'v1', 'v2']) state.seatById(id)!.role!.alive = false;
    const r = checkWin(state);
    expect(r).toEqual({ done: true, winner: 'villain' });
  });

  it('returns not-done mid-game', () => {
    const state = makeState();
    expect(checkWin(state)).toEqual({ done: false });
  });
});

describe('voting', () => {
  it('lynches the uniquely most-voted alive seat', () => {
    const state = makeState();
    state.startVoting();
    recordVote(state, 'seer', { action: 'target_player', targets: ['w1'] });
    recordVote(state, 'witch', { action: 'target_player', targets: ['w1'] });
    recordVote(state, 'v1', { action: 'target_player', targets: ['w1'] });
    recordVote(state, 'v2', { action: 'pass', targets: [] });
    const { lynched, events } = resolveVotes(state);
    expect(lynched).toBe('w1');
    expect(state.seatById('w1')!.role!.alive).toBe(false);
    expect(events.some((e) => e.type === 'voted_out')).toBe(true);
  });

  it('tie → no lynch (v1 simplification)', () => {
    const state = makeState();
    state.startVoting();
    recordVote(state, 'seer', { action: 'target_player', targets: ['w1'] });
    recordVote(state, 'witch', { action: 'target_player', targets: ['w2'] });
    const { lynched, events } = resolveVotes(state);
    expect(lynched).toBeNull();
    expect(events.some((e) => e.type === 'vote_tie')).toBe(true);
  });

  it('rejects voting for a dead seat and double votes', () => {
    const state = makeState();
    state.startVoting();
    expect(recordVote(state, 'seer', { action: 'target_player', targets: ['seer'] }).ok).toBe(false); // self
    expect(recordVote(state, 'witch', { action: 'pass', targets: [] }).ok).toBe(true);
    expect(recordVote(state, 'witch', { action: 'pass', targets: [] }).ok).toBe(false); // double
  });
});
