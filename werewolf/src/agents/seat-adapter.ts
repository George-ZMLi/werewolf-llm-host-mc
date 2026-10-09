import type { EngineState } from '../engine/state';
import type { AgentAction, SeatState } from '../engine/types';
import type { LlmClient } from '../llm/types';
import { HostAgent } from './host-agent';
import { PlayerAgent } from './player-agent';

/** Engine callback for a seat's final submission (plan task 7). */
export type SeatHandler = (seat: SeatState, action: AgentAction | string) => void;

function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Routes a seat's turn to the right source (LLM agent or human) and submits
 * the final result (plan task 7). Human submissions are hard-capped by the
 * remaining phase budget: on expiry a safe default is submitted and a
 * timeout event is recorded, so the game never stalls (spec section 6).
 * Host seats never take turns; they are driven by runHostTurn().
 */
export class SeatAdapter {
  private readonly state: EngineState;
  private readonly client: LlmClient;
  private readonly humanSubmit: (seatId: string) => Promise<AgentAction | string>;
  private readonly submit?: SeatHandler;
  /** Final submission per seat, for orchestrator consumption. */
  readonly submissions: Map<string, AgentAction | string> = new Map();

  constructor(
    state: EngineState,
    llmClient: LlmClient,
    humanSubmit: (seatId: string) => Promise<AgentAction | string>,
    submit?: SeatHandler,
  ) {
    this.state = state;
    this.client = llmClient;
    this.humanSubmit = humanSubmit;
    this.submit = submit;
  }

  /** Run one seat's turn, then submit its final action (never throws for game play). */
  async runTurn(seatId: string): Promise<void> {
    const seat = this.state.seatById(seatId);
    if (!seat) throw new Error('unknown seat ' + seatId);
    if (seat.kind === 'host') throw new Error('host seats are driven by runHostTurn');
    if (seat.role?.alive === false) return; // dead seats take no turns

    let action: AgentAction | string;
    if (seat.kind === 'agent') {
      const agent = new PlayerAgent(seatId, this.client, this.state);
      action =
        this.state.phase === 'day_discussion' ? await agent.onDaySpeech() : await agent.onNightAction();
    } else {
      const budgetMs = this.state.phaseRemainingMs();
      const pending = this.humanSubmit(seatId);
      const outcome = await Promise.race([
        pending.then(() => 'human' as const),
        after(budgetMs).then(() => 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        action = { action: 'pass', targets: [] };
        this.state.recordEvent('timeout', { seatId }, null);
      } else {
        action = await pending; // already resolved: it won the race
      }
    }

    this.submissions.set(seatId, action);
    this.submit?.(seat, action);
  }

  /** Drive the host seat: announce the phase, check silence during discussion. */
  async runHostTurn(): Promise<void> {
    const host = new HostAgent(this.client, this.state);
    await host.announcePhaseTransition();
    if (this.state.phase === 'day_discussion') await host.observeSilence();
  }
}
