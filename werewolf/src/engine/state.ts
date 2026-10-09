import type { Event, GamePhase, RoleConfig, SeatState } from './types';
import { dealRoles, validateRoleConfig } from './deck';

/** In-game phase cycle, repeated until a win (spec §2.3). */
const PHASE_CYCLE: GamePhase[] = ['night', 'dawn', 'day_discussion', 'voting'];

/** Per-night scratch space; reset by startNight(). */
export interface NightPending {
  /** Seat ids targeted for a kill this night (collected from werewolf turns). */
  kills: string[];
  /** Seat ids saved by the witch this night. */
  saves: string[];
  /** Seer observations computed by the engine, returned only to the seer. */
  observations: { observerId: string; targetId: string; isWerewolf: boolean }[];
}

function freshNightPending(): NightPending {
  return { kills: [], saves: [], observations: [] };
}

/**
 * The engine's game state: seats, phase machine, per-phase wall-clock budgets,
 * and the event log.
 *
 * Determinism rules (spec §8):
 * - No Date objects — `now` is an injected function returning UTC epoch ms.
 * - No Math.random — all randomness comes from the injected rng.
 */
export class EngineState {
  readonly seats: SeatState[];
  readonly rng: () => number;
  private readonly nowImpl: () => number;
  private readonly timings: Record<GamePhase, number>;

  phase: GamePhase = 'lobby';
  phaseStartedAt: number;
  currentPhaseBudgetMs: number = 0;
  log: Event[] = [];
  nightPending: NightPending = freshNightPending();
  /** voter seatId → target seatId (null = abstain); reset each voting phase. */
  currentVotes: Map<string, string | null> = new Map();
  winner: 'villain' | 'villager' | null = null;
  /** Role configs in use; set by deal(). */
  roleConfigs: RoleConfig[] = [];

  constructor(
    seats: SeatState[],
    timings: Record<GamePhase, number>,
    rng: () => number,
    now?: () => number,
  ) {
    this.seats = seats;
    this.timings = timings;
    this.rng = rng;
    this.nowImpl = now ?? Date.now;
    this.phaseStartedAt = this.now();
  }

  now(): number {
    return this.nowImpl();
  }

  /**
   * Deal roles from a validated config (spec §2.1). Throws on invalid config.
   * Emits one private role_assigned event per seat (werewolves see all wolf
   * assignments) plus a public game_dealt marker.
   */
  deal(config: RoleConfig[]): void {
    const violations = validateRoleConfig(config, this.seats.length);
    if (violations.length > 0) {
      throw new Error('cannot deal: ' + violations.join('; '));
    }
    const ids = dealRoles(config, this.seats.length, this.rng);
    const byId = new Map(config.map((r) => [r.id, r]));
    const wolfSeatIds: string[] = [];

    this.seats.forEach((seat, i) => {
      const role = byId.get(ids[i]);
      if (!role) throw new Error(`unknown role id ${ids[i]} in deal`);
      seat.role = { roleId: role.id, faction: role.faction, alive: true, extra: {} };
      if (role.faction === 'villain') wolfSeatIds.push(seat.seatId);
    });

    // Mark the first wolf (by seat order) as leader (spec §2.1 example).
    wolfSeatIds.forEach((sid, i) => {
      const seat = this.seatById(sid);
      if (seat?.role) seat.role.extra = { ...(seat.role.extra ?? {}), isWerewolfLeader: i === 0 };
    });

    this.roleConfigs = config;

    for (const seat of this.seats) {
      const visible = seat.role!.faction === 'villain' ? wolfSeatIds : [seat.seatId];
      this.recordEvent('role_assigned', { seatId: seat.seatId, role: seat.role!.roleId }, visible);
    }
    this.recordEvent('game_dealt', { seatCount: this.seats.length }, null);
  }

  startNight(): void {
    this.nightPending = freshNightPending();
    this.enter('night');
  }

  startDawn(): void {
    this.enter('dawn');
  }

  startDayDiscussion(): void {
    this.enter('day_discussion');
  }

  startVoting(): void {
    this.currentVotes = new Map();
    this.enter('voting');
  }

  /** night→dawn→day_discussion→voting→night (spec §2.3). No-op when finished. */
  advancePhase(): GamePhase {
    if (this.phase === 'finished') return this.phase;
    const idx = PHASE_CYCLE.indexOf(this.phase);
    if (idx === -1) throw new Error(`cannot advance from phase ${this.phase}`);
    this.enter(PHASE_CYCLE[(idx + 1) % PHASE_CYCLE.length]);
    return this.phase;
  }

  /** Record a win and stop the game (called by the orchestrator after checkWin). */
  finish(winner: 'villain' | 'villager'): void {
    this.winner = winner;
    this.enter('finished');
  }

  private enter(phase: GamePhase): void {
    this.phase = phase;
    this.currentPhaseBudgetMs = this.timings[phase] ?? 0;
    this.phaseStartedAt = this.now();
    this.recordEvent('phase_change', { phase }, null);
  }

  /**
   * Record an engine event. `visibleTo` null = public, array = private (spec §4).
   * Returns the stored event.
   */
  recordEvent(type: string, payload: Record<string, unknown>, visibleTo: string[] | null = null): Event {
    const event: Event = { ts: this.now(), phase: this.phase, type, payload, visibleTo };
    this.log.push(event);
    return event;
  }

  /** ms left in the current phase per the injected clock; clamped at 0. */
  phaseRemainingMs(): number {
    return Math.max(0, this.phaseStartedAt + this.currentPhaseBudgetMs - this.now());
  }

  aliveSeats(): SeatState[] {
    return this.seats.filter((s) => s.role?.alive !== false);
  }

  seatById(seatId: string): SeatState | undefined {
    return this.seats.find((s) => s.seatId === seatId);
  }

  roleConfigForSeat(seatId: string): RoleConfig | undefined {
    const seat = this.seatById(seatId);
    if (!seat?.role) return undefined;
    return this.roleConfigs.find((r) => r.id === seat.role!.roleId);
  }
}
