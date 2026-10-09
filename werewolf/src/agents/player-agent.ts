import type { EngineState } from '../engine/state';
import type { AgentAction, AgentPromptContext } from '../engine/types';
import type { LlmClient } from '../llm/types';
import { DECISION_SCHEMA_JSON, callAgentDecision } from './llm-call';

/** Fallback day remark used when the LLM is unavailable (game never stalls). */
export const DEFAULT_DAY_SPEECH = '（本轮不发言）';

/**
 * LLM player agent (plan task 6): roleplay decisions for one seat.
 * Visibility is enforced here (spec section 4): the prompt context carries
 * only public events plus events whose visibleTo includes this seat.
 * onNightAction never throws: LLM failures resolve to a safe default via
 * callAgentDecision's internal fallback.
 */
export class PlayerAgent {
  private readonly seatId: string;
  private readonly client: LlmClient;
  private readonly state: EngineState;
  private readonly persona?: string;

  constructor(seatId: string, client: LlmClient, state: EngineState, persona?: string) {
    this.seatId = seatId;
    this.client = client;
    this.state = state;
    this.persona = persona;
  }

  /** Build this seat's legal prompt context (visibleTo respected). */
  buildContext(): AgentPromptContext {
    const role = this.state.roleConfigForSeat(this.seatId);
    if (!role) throw new Error('seat ' + this.seatId + ' has no role assigned');
    return {
      role,
      publicLog: this.state.log.filter((e) => e.visibleTo === null),
      privateLog: this.state.log.filter((e) => e.visibleTo?.includes(this.seatId)),
      aliveSeats: this.state.aliveSeats(),
      selfSeatId: this.seatId,
      persona: this.persona,
    };
  }

  /** Night skill decision: a valid AgentAction; never throws (fallback internal). */
  async onNightAction(): Promise<AgentAction> {
    const ctx = this.buildContext();
    const { decision } = await callAgentDecision(this.client, ctx, DECISION_SCHEMA_JSON, () => this.state.now());
    return decision;
  }

  /** Day discussion: a short in-character remark (1-3 sentences). */
  async onDaySpeech(): Promise<string> {
    const ctx = this.buildContext();
    const lines = [
      'You play seat ' + this.seatId + ' in a werewolf game.',
      'Your role: ' + ctx.role.name + ' (faction: ' + ctx.role.faction + ').' + (this.persona ? ' Persona: ' + this.persona : ''),
      'Recent public events:',
      ...ctx.publicLog.slice(-6).map((e) => '- ' + e.type),
      'Write a 1-3 sentence in-character remark for the day discussion.',
      'Do not mention any real-world dates or times.',
    ];
    try {
      const raw = await this.client(lines.join('\n'), { temperature: 0 });
      const text = raw.trim();
      return text.length > 0 ? text : DEFAULT_DAY_SPEECH;
    } catch {
      return DEFAULT_DAY_SPEECH;
    }
  }
}
