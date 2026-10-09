import type { EngineState } from './state';
import type { AgentAction, Event, NightOutcome } from './types';

/**
 * Night-skill resolution and win checking (spec §2.4–§2.5, plan task 3).
 *
 * All functions are pure over the passed EngineState: they mutate state's
 * scratch fields (nightPending, seats) and append engine events.
 */

function wolfSeatIds(state: EngineState): string[] {
  return state.seats
    .filter((s) => s.role?.faction === 'villain')
    .map((s) => s.seatId);
}

/**
 * Resolve one seat's night action. Validates:
 *  - the seat has a living role with a night rule,
 *  - the action type matches the role's night.action (pass is always legal),
 *  - target count == role.night.targets and <= maxTargets,
 *  - no self-target, no dead/unknown targets,
 *  - once-per-game flag (skillUsed) is honored.
 *
 * On success, applies the effect to state.nightPending and returns the events
 * (visibility already set).
 */
export function resolveNightAction(
  state: EngineState,
  seatId: string,
  action: AgentAction,
): NightOutcome {
  const seat = state.seatById(seatId);
  const roleState = seat?.role;
  if (!seat || !roleState) return { ok: false, reason: `seat ${seatId} has no role` };
  if (!roleState.alive) return { ok: false, reason: 'seat is dead' };
  const cfg = state.roleConfigForSeat(seatId);
  if (!cfg) return { ok: false, reason: 'role config not found' };
  const night = cfg.night;
  if (!night) return { ok: false, reason: `role ${cfg.id} has no night rule` };

  if (action.action === 'pass') {
    if (action.targets.length !== 0) return { ok: false, reason: 'pass takes no targets' };
    return { ok: true, events: [state.recordEvent('night_pass', { seatId, role: cfg.id }, [seatId])] };
  }

  if (action.action !== night.action) {
    return { ok: false, reason: `role ${cfg.id} night action must be "${night.action}"` };
  }

  if (roleState.skillUsed) {
    return { ok: false, reason: `skill for ${cfg.id} already used this game` };
  }

  if (action.targets.length !== night.targets) {
    return {
      ok: false,
      reason: `expected exactly ${night.targets} target(s), got ${action.targets.length}`,
    };
  }
  if (action.targets.length > night.maxTargets) {
    return { ok: false, reason: `more targets than maxTargets ${night.maxTargets}` };
  }

  for (const t of action.targets) {
    if (t === seatId) return { ok: false, reason: 'cannot target self' };
    const target = state.seatById(t);
    if (!target || !target.role) return { ok: false, reason: `unknown target ${t}` };
    if (!target.role.alive) return { ok: false, reason: `target ${t} is dead` };
  }

  roleState.skillUsed = true;
  roleState.skillTarget = action.targets[0];

  switch (night.action) {
    case 'target_player': {
      state.nightPending.kills.push(...action.targets);
      const wolves = wolfSeatIds(state);
      return {
        ok: true,
        events: [
          state.recordEvent(
            'werewolf_kill',
            { seatId, targets: action.targets },
            wolves.length > 0 ? wolves : null,
          ),
        ],
      };
    }
    case 'protect': {
      state.nightPending.saves.push(...action.targets);
      return {
        ok: true,
        events: [
          state.recordEvent('witch_save', { seatId, target: action.targets[0] }, [seatId]),
        ],
      };
    }
    case 'observe': {
      const target = state.seatById(action.targets[0])!;
      const isWerewolf = target.role?.faction === 'villain';
      state.nightPending.observations.push({
        observerId: seatId,
        targetId: action.targets[0],
        isWerewolf,
      });
      return {
        ok: true,
        events: [
          state.recordEvent(
            'seer_result',
            { targetSeatId: action.targets[0], isWerewolf },
            [seatId],
          ),
        ],
      };
    }
    default:
      return { ok: false, reason: `unsupported night action ${action.action}` };
  }
}

/** Majority wolf target; ties resolve to the first target in seat order (deterministic). */
function pickWolfTarget(kills: string[]): string | null {
  if (kills.length === 0) return null;
  const counts = new Map<string, number>();
  for (const k of kills) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const k of kills) {
    const n = counts.get(k) ?? 0;
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

/**
 * Apply the night's pending outcomes at dawn: the (majority) wolf kill,
 * cancelled by the witch's save if present. Marks deaths, emits public
 * dawn events. Idempotent-safe: dead seats are never re-killed.
 */
export function resolveDawn(state: EngineState): Event[] {
  const kills = [...new Set(state.nightPending.kills)];
  const saves = new Set(state.nightPending.saves);
  const target = pickWolfTarget(kills);

  let dead: string[] = [];
  let saved: string[] = [];
  if (target !== null) {
    const seat = state.seatById(target);
    if (seat?.role && seat.role.alive) {
      if (saves.has(target)) {
        saved = [target];
      } else {
        seat.role.alive = false;
        dead = [target];
      }
    }
  }

  const events: Event[] = [];
  for (const seatId of dead) {
    events.push(state.recordEvent('player_died', { seatId, cause: 'werewolf' }, null));
  }
  if (saved.length > 0) {
    events.push(state.recordEvent('night_saved', { seats: saved }, null));
  }
  events.push(
    state.recordEvent('dawn_announcement', { dead, saved }, null),
  );
  return events;
}

/**
 * Win check (spec §2.5, plan task 3):
 *  - all werewolves dead        → villager faction wins
 *  - all non-werewolves dead    → villain faction wins
 * Runs at the end of every dawn and after every voting phase.
 */
export function checkWin(
  state: EngineState,
): { done: boolean; winner?: 'villain' | 'villager' } {
  const withRoles = state.seats.filter((s) => s.role !== undefined);
  if (withRoles.length === 0) return { done: false };
  const alive = withRoles.filter((s) => s.role!.alive);
  const wolves = alive.filter((s) => s.role!.faction === 'villain');
  const villagers = alive.filter((s) => s.role!.faction === 'villager');
  if (wolves.length === 0) return { done: true, winner: 'villager' };
  if (villagers.length === 0) return { done: true, winner: 'villain' };
  return { done: false };
}

/**
 * Record one seat's vote. `pass` / empty targets = abstain.
 * Voting for a dead seat or for self is void (rejected).
 */
export function recordVote(
  state: EngineState,
  seatId: string,
  action: AgentAction,
): { ok: boolean; reason?: string } {
  const seat = state.seatById(seatId);
  if (!seat?.role || !seat.role.alive) return { ok: false, reason: 'seat has no living role' };
  if (state.currentVotes.has(seatId)) return { ok: false, reason: 'seat already voted' };
  if (action.action === 'pass' || action.targets.length === 0) {
    state.currentVotes.set(seatId, null);
    return { ok: true };
  }
  if (action.targets.length !== 1) return { ok: false, reason: 'a vote takes exactly one target' };
  const target = state.seatById(action.targets[0]);
  if (action.targets[0] === seatId) return { ok: false, reason: 'cannot vote for self' };
  if (!target?.role || !target.role.alive) return { ok: false, reason: `invalid vote target ${action.targets[0]}` };
  state.currentVotes.set(seatId, action.targets[0]);
  return { ok: true };
}

/**
 * Tally the voting phase. Highest unique count → lynched (marked dead, public
 * event). A tie (or no votes at all) → no lynch (v1; spec §2.3 re-vote loop is
 * a documented v1 simplification).
 */
export function resolveVotes(state: EngineState): { events: Event[]; lynched: string | null } {
  const events: Event[] = [];
  const tally = new Map<string, number>();
  for (const [voter, target] of state.currentVotes) {
    if (target === null || target === voter) continue;
    const t = state.seatById(target);
    if (!t?.role || !t.role.alive) continue;
    tally.set(target, (tally.get(target) ?? 0) + 1);
  }

  let lynched: string | null = null;
  if (tally.size > 0) {
    let max = 0;
    for (const n of tally.values()) max = Math.max(max, n);
    const top = [...tally.entries()].filter(([, n]) => n === max).map(([id]) => id);
    if (top.length === 1) {
      lynched = top[0];
      const seat = state.seatById(lynched)!;
      if (seat.role?.alive) {
        seat.role.alive = false;
        events.push(state.recordEvent('voted_out', { seatId: lynched }, null));
      }
    } else {
      events.push(state.recordEvent('vote_tie', { targets: top }, null));
    }
  } else {
    events.push(state.recordEvent('no_lynch', {}, null));
  }
  return { events, lynched };
}
