import type { EngineState } from './engine/state';
import type { Event, RoleConfig } from './engine/types';
import { checkWin, recordVote, resolveDawn, resolveNightAction, resolveVotes } from './engine/skills';
import type { SeatAdapter } from './agents/seat-adapter';
import type { HostAgent } from './agents/host-agent';

/**
 * Game orchestrator (plan task 8): the end-to-end loop that drives phases,
 * seat turns, host pacing and win checking. It never blocks a phase: every
 * phase is guarded by the remaining phase budget, and slow or missing turns
 * fall back to safe defaults so the game always advances.
 */
export class Orchestrator {
  /** True while runUntilDone is executing. */
  isRunning = false;

  /** Public so the transport layer can build room snapshots and re-syncs (task 9). */
  readonly state: EngineState;
  private readonly adapter: SeatAdapter;
  private readonly host: HostAgent;
  private readonly onEvent: (e: Event) => void;
  private readonly now: () => number; // reserved for PhaseTimer (task 13)
  private emitted = 0;

  constructor(
    state: EngineState,
    adapter: SeatAdapter,
    host: HostAgent,
    onEvent: (e: Event) => void,
    now: () => number,
  ) {
    this.state = state;
    this.adapter = adapter;
    this.host = host;
    this.onEvent = onEvent;
    this.now = now;
    this.emitted = state.log.length;
  }

  /** Forward every engine event recorded since the last flush, exactly once. */
  private flush(): void {
    while (this.emitted < this.state.log.length) this.onEvent(this.state.log[this.emitted++]);
  }

  private phaseOver(): boolean {
    return this.state.phaseRemainingMs() <= 0;
  }

  /** Deal roles and enter the night phase (spec: start = deal + enter night loop). */
  async start(config: RoleConfig[]): Promise<void> {
    if (this.state.phase !== 'lobby') throw new Error('game already started');
    this.state.deal(config);
    this.flush();
    this.state.startNight();
    this.flush();
  }

  /** Loop phases until the game is decided. */
  async runUntilDone(): Promise<{ winner: 'villain' | 'villager' }> {
    if (this.state.phase === 'finished') throw new Error('game already finished');
    this.isRunning = true;
    try {
      for (;;) {
        switch (this.state.phase) {
          case 'night':
            await this.runNightPhase();
            break;
          case 'dawn':
            this.runDawnPhase();
            break;
          case 'day_discussion':
            await this.runDiscussionPhase();
            break;
          case 'voting':
            await this.runVotingPhase();
            break;
          default:
            break;
        }
        const win = checkWin(this.state);
        if (win.done && win.winner) {
          this.state.finish(win.winner);
          this.flush();
          return { winner: win.winner };
        }
        this.state.advancePhase();
        this.flush();
      }
    } finally {
      this.isRunning = false;
    }
  }

  /** Night: each role in night.order acts; invalid actions are rejected, never fatal. */
  private async runNightPhase(): Promise<void> {
    const nightRoles = this.state.roleConfigs
      .filter((r) => r.night)
      .sort((a, b) => (a.night?.order ?? 0) - (b.night?.order ?? 0));
    for (const role of nightRoles) {
      if (this.phaseOver()) break;
      for (const seat of this.state.aliveSeats()) {
        if (this.phaseOver()) break;
        if (seat.role?.roleId !== role.id) continue;
        await this.adapter.runTurn(seat.seatId);
        const sub = this.adapter.submissions.get(seat.seatId);
        const action =
          typeof sub === 'string'
            ? { action: 'pass' as const, targets: [] as string[] }
            : sub;
        if (!action) {
          this.state.recordEvent('action_rejected', { seatId: seat.seatId, reason: 'no submission' }, null);
          continue;
        }
        const outcome = resolveNightAction(this.state, seat.seatId, action);
        if (!outcome.ok) {
          this.state.recordEvent('action_rejected', { seatId: seat.seatId, reason: outcome.reason }, null);
        }
      }
    }
    this.flush();
  }

  /** Dawn: apply the night outcome (kills, saves, observations). */
  private runDawnPhase(): void {
    resolveDawn(this.state);
    this.flush();
  }

  /** Discussion: host narrates, each alive seat speaks, host checks silence. */
  private async runDiscussionPhase(): Promise<void> {
    await this.host.announcePhaseTransition();
    for (const seat of this.state.aliveSeats()) {
      if (this.phaseOver()) break;
      if (seat.kind === 'host') continue;
      await this.adapter.runTurn(seat.seatId);
      const sub = this.adapter.submissions.get(seat.seatId);
      const text = typeof sub === 'string' ? sub : '';
      this.state.recordEvent('player_speech', { seatId: seat.seatId, text }, null);
    }
    await this.host.observeSilence();
    this.flush();
  }

  /** Voting: each alive seat votes; ties and no-lynch are engine events. */
  private async runVotingPhase(): Promise<void> {
    for (const seat of this.state.aliveSeats()) {
      if (this.phaseOver()) break;
      if (seat.kind === 'host') continue;
      await this.adapter.runTurn(seat.seatId);
      const sub = this.adapter.submissions.get(seat.seatId);
      const action =
        typeof sub === 'string'
          ? { action: 'pass' as const, targets: [] as string[] }
          : sub;
      if (!action) continue;
      const res = recordVote(this.state, seat.seatId, action);
      if (!res.ok) {
        this.state.recordEvent('vote_rejected', { seatId: seat.seatId, reason: res.reason }, null);
      }
    }
    resolveVotes(this.state);
    this.flush();
  }
}
