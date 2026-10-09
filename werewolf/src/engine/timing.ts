/**
 * PhaseTimer (plan task 13): per-phase wall-clock budget enforcement with
 * idempotent expiry.
 *
 * Driven by an injected clock - never Date.now internally. Expiry fires
 * through the orchestrator's tick loop (tick() / onExpiry registration);
 * the timer itself schedules no real-time side effects, so behavior is
 * fully determined by the injected now() (spec §8 determinism).
 */
import type { EngineState } from './state';
import type { GamePhase } from './types';

/** Optional config form: budgets plus per-phase soft-warn offsets (UI). */
export interface PhaseTimingsConfig {
  budgetMs: Record<GamePhase, number>;
  /** Soft-warn offset per phase (ms before deadline) for UI countdown highlight. */
  softWarnMs?: Partial<Record<GamePhase, number>>;
}

export class PhaseTimer {
  private readonly state: EngineState;
  private readonly now: () => number;
  private readonly budgetMs: Record<GamePhase, number>;
  private readonly softWarn: Partial<Record<GamePhase, number>>;
  private expiryCb: (() => void) | null = null;
  private fired = false;

  constructor(
    state: EngineState,
    timings: Record<GamePhase, number> | PhaseTimingsConfig,
    now: () => number,
  ) {
    this.state = state;
    this.now = now;
    if ('budgetMs' in timings) {
      this.budgetMs = timings.budgetMs;
      this.softWarn = timings.softWarnMs ?? {};
    } else {
      this.budgetMs = timings;
      this.softWarn = {};
    }
  }

  /** ms left in the current phase per the injected clock; clamped at 0. */
  remainingMs(): number {
    const budget = this.budgetMs[this.state.phase] ?? 0;
    return Math.max(0, this.state.phaseStartedAt + budget - this.now());
  }

  /** The configured soft-warn offset for the current phase (0 if unconfigured). */
  softWarnMs(): number {
    return this.softWarn[this.state.phase] ?? 0;
  }

  /** True once the expiry callback has fired. */
  isFired(): boolean {
    return this.fired;
  }

  /**
   * Register the expiry callback: fired at most once when the phase budget
   * is exhausted. No-op if already fired. If the phase is already overdue,
   * the callback fires synchronously.
   */
  onExpiry(cb: () => void): void {
    if (this.fired) return;
    this.expiryCb = cb; // last registration wins (pre-fire)
    this.fireIfOverdue();
  }

  /**
   * Called by the orchestrator's tick loop: fires the registered callback
   * exactly once when remainingMs() <= 0. Returns true iff it fired.
   */
  tick(): boolean {
    return this.fireIfOverdue();
  }

  private fireIfOverdue(): boolean {
    if (this.fired) return false;
    if (this.remainingMs() > 0) return false;
    this.fired = true;
    const cb = this.expiryCb;
    this.expiryCb = null;
    if (cb) cb();
    return true;
  }
}
