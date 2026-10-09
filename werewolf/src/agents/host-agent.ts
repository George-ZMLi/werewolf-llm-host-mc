import type { EngineState } from '../engine/state';
import type { Event } from '../engine/types';
import type { LlmClient } from '../llm/types';

/**
 * LLM host/MC agent (spec section 6, plan task 5):
 *  - announces phase transitions with a short narration (temperature 0),
 *  - nudges a silent day_discussion when message cadence drops below the
 *    configured threshold (host_nudge),
 *  - issues a final-call nudge right before a phase timer expires.
 * All best-effort LLM work is bounded by the remaining phase budget: the
 * host never blocks the phase timer (spec section 6).
 */

/** Timings document shape (data/timings-default.json). */
export interface HostTimings {
  budgetMs?: Record<string, number>;
  hostNudge?: { enabled?: boolean; minMsgPerMin?: number; silenceThresholdSec?: number };
}

/** Event types emitted by the host (consumed by transport + UI). */
export const HOST_EVENT_TYPES = ['host_announcement', 'host_nudge', 'host_final_call'] as const;

function stripTs(e: Event): Record<string, unknown> {
  const { ts: _ts, ...rest } = e;
  return rest;
}

function publicTail(state: EngineState, n: number): Event[] {
  return state.log.filter((e) => e.visibleTo === null).slice(-n);
}

/** Deterministic fallback narration; used when the LLM is unavailable. */
export function defaultNarration(phase: string): string {
  switch (phase) {
    case 'night':
      return '天黑了，所有玩家请闭眼休息，等待夜间的行动。';
    case 'dawn':
      return '天亮了，请主持人公布昨夜发生的事。';
    case 'day_discussion':
      return '进入白天讨论阶段，请按座位顺序依次发言。';
    case 'voting':
      return '讨论结束，进入投票阶段，请投出你怀疑的对象。';
    case 'lobby':
      return '玩家已就座，游戏即将开始。';
    case 'finished':
      return '游戏结束。';
    default:
      return '游戏阶段更新：' + phase;
  }
}

/** Race an LLM call against a wall-clock budget; resolves undefined on timeout. */
function boundedLlmCall(client: LlmClient, prompt: string, budgetMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), budgetMs);
    client(prompt, { temperature: 0 }).then(
      (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function narrationPrompt(state: EngineState): string {
  const lines = [
    'You are the game host (MC) of a werewolf (狼人杀) game.',
    'Current phase: ' + state.phase,
    'Recent public events:',
  ];
  const tail = publicTail(state, 5);
  if (tail.length === 0) lines.push('- (none)');
  for (const e of tail) lines.push('- ' + e.type + ': ' + JSON.stringify(stripTs(e)));
  lines.push('Write a short narration (1-2 sentences) announcing the current phase.');
  lines.push('Do not mention any wall-clock time or date.');
  return lines.join('\n');
}

function silencePrompt(): string {
  return [
    'You are the game host of a werewolf game.',
    'The day discussion has been quiet for a while.',
    'Write a short nudge (1 sentence) that encourages players to speak.',
    'Do not mention any wall-clock time or date.',
  ].join('\n');
}

function finalCallPrompt(): string {
  return [
    'You are the game host of a werewolf game.',
    'The current phase timer is about to expire.',
    'Write a short final-call (1 sentence) urging players to finish quickly.',
    'Do not mention any wall-clock time or date.',
  ].join('\n');
}

export class HostAgent {
  private readonly client: LlmClient;
  private readonly state: EngineState;
  private readonly timings: HostTimings;

  constructor(client: LlmClient, state: EngineState, timings: HostTimings = {}) {
    this.client = client;
    this.state = state;
    this.timings = timings;
  }

  /**
   * Announce a phase transition: an LLM narration (bounded by the remaining
   * phase budget) recorded as a public host_announcement event.
   */
  async announcePhaseTransition(): Promise<Event> {
    const budget = this.state.phaseRemainingMs();
    let text = defaultNarration(this.state.phase);
    if (budget > 0) {
      const raw = await boundedLlmCall(this.client, narrationPrompt(this.state), budget);
      if (raw !== undefined && raw.trim().length > 0) text = raw.trim();
    }
    return this.state.recordEvent('host_announcement', { phase: this.state.phase, text }, null);
  }

  /**
   * Nudge a silent day_discussion. Returns a host_nudge event when the
   * silence exceeds the threshold AND the message cadence is below
   * minMsgPerMin; otherwise null. Never blocks the phase timer: if the LLM
   * call exceeds the remaining budget, resolves null.
   */
  async observeSilence(): Promise<Event | null> {
    if (this.state.phase !== 'day_discussion') return null;
    const nudge = this.timings.hostNudge;
    if (!nudge?.enabled) return null;

    const now = this.state.now();
    const phaseStart = this.state.phaseStartedAt;
    const msgs = this.state.log.filter(
      (e) => e.phase === 'day_discussion' && e.type === 'player_speech' && e.ts >= phaseStart,
    );
    const lastTs = msgs.length > 0 ? msgs[msgs.length - 1].ts : phaseStart;
    const silenceThresholdMs = (nudge.silenceThresholdSec ?? 20) * 1000;
    if (now - lastTs < silenceThresholdMs) return null;

    const perMin = msgs.length > 0 ? (msgs.length / Math.max(1, now - phaseStart)) * 60000 : 0;
    if (perMin > (nudge.minMsgPerMin ?? 2)) return null; // cadence is fine

    const budget = this.state.phaseRemainingMs();
    if (budget <= 0) return null; // best-effort: never block the timer
    const raw = await boundedLlmCall(this.client, silencePrompt(), budget);
    if (raw === undefined) return null; // LLM exceeded budget: skip the nudge
    return this.state.recordEvent('host_nudge', { text: raw.trim() }, null);
  }

  /**
   * Final-call nudge right before the phase timer expires. Always records a
   * host_final_call event (LLM text when in time, deterministic template
   * otherwise).
   */
  async forceFinalCall(): Promise<Event> {
    const budget = this.state.phaseRemainingMs();
    let text = '最后提醒：时间快到了，请尽快完成你的发言或投票！';
    if (budget > 0) {
      const raw = await boundedLlmCall(this.client, finalCallPrompt(), budget);
      if (raw !== undefined && raw.trim().length > 0) text = raw.trim();
    }
    return this.state.recordEvent('host_final_call', { phase: this.state.phase, text }, null);
  }
}
