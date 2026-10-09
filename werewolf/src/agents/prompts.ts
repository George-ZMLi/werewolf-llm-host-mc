/**
 * Prompt template builders for LLM agents (plan task 12).
 *
 * Fixed string templates - never LLM-generated. Redaction (spec §4):
 * publicLog is always spliced in; privateLog only when the event's
 * visibleTo includes the acting seat (the builders re-filter and never
 * trust a caller). No Date / Date.now() value is ever stringified into
 * the output (determinism constraint, spec §8).
 */
import type { EngineState } from '../engine/state';
import type {
  AgentPromptContext,
  Event,
  GamePhase,
  RoleConfig,
  SeatState,
} from '../engine/types';

const DECISION_INSTRUCTION =
  'Reply with ONLY a JSON object: ' +
  '{"action":"<target_player|protect|observe|pass>","targets":["<seatId>"],"speech":"<optional text>","confidence":<number 0..1>};' +
  ' no prose outside the JSON.';

function renderSeats(seats: SeatState[]): string {
  if (seats.length === 0) return '(none)';
  return seats.map((s) => s.seatId + '(' + s.name + ')').join(', ');
}

function renderLog(events: Event[]): string {
  if (events.length === 0) return '(none)';
  return events
    .map((e, i) => (i + 1) + '. [' + e.phase + '] ' + e.type + ' ' + JSON.stringify(e.payload))
    .join('\n');
}

function publicEvents(ctx: AgentPromptContext): Event[] {
  return ctx.publicLog.filter((e) => e.visibleTo === null);
}

/** Events this seat may legally see in its private history (spec §4). */
function privateEvents(ctx: AgentPromptContext): Event[] {
  return ctx.privateLog.filter(
    (e) => e.visibleTo !== null && e.visibleTo.includes(ctx.selfSeatId),
  );
}

function roleLine(role: RoleConfig): string {
  return 'Your role: ' + role.name + ' (' + role.id + ') - faction: ' + role.faction + '.';
}

/**
 * Night-phase prompt for a seat's role (plan task 12). The LLM must reply
 * with a strict-JSON decision the engine will resolve.
 */
export function buildNightPrompt(role: RoleConfig, ctx: AgentPromptContext): string {
  const pub = publicEvents(ctx);
  const priv = privateEvents(ctx);
  const parts: string[] = [];
  parts.push('You are playing Werewolf (werewolf). It is the night phase.');
  parts.push(roleLine(role));
  if (role.night) {
    const t = role.night;
    parts.push(
      'Your night skill: ' + t.action + ' on up to ' + t.maxTargets + ' target(s), execution order ' + t.order +
      (t.promptTemplateId ? ' [template ' + t.promptTemplateId + ']' : '') + '.',
    );
  } else {
    parts.push('Your role takes no night action; choose pass.');
  }
  parts.push('Alive seats: ' + renderSeats(ctx.aliveSeats));
  parts.push('Public history:');
  parts.push(renderLog(pub));
  if (priv.length > 0) {
    parts.push('Private history (hidden from other players - never reveal it):');
    parts.push(renderLog(priv));
  }
  if (ctx.persona) {
    parts.push('Persona: ' + ctx.persona);
  }
  parts.push(DECISION_INSTRUCTION);
  return parts.join('\n');
}

/**
 * Day-phase (discussion) prompt. The LLM replies with a short plain-text
 * speech; the engine records it as a player_speech event.
 */
export function buildDayPrompt(role: RoleConfig, ctx: AgentPromptContext, persona?: string): string {
  const pub = publicEvents(ctx);
  const priv = privateEvents(ctx);
  const parts: string[] = [];
  parts.push('You are playing Werewolf (werewolf). It is the day discussion phase.');
  parts.push(roleLine(role));
  if (role.day) {
    const d = role.day;
    if (d.action) parts.push('Day behaviour: ' + d.action + (d.promptTemplateId ? ' [template ' + d.promptTemplateId + ']' : '') + '.');
  }
  parts.push('Alive seats: ' + renderSeats(ctx.aliveSeats));
  parts.push('Public history:');
  parts.push(renderLog(pub));
  if (priv.length > 0) {
    parts.push('Private history (hidden from other players - never reveal it):');
    parts.push(renderLog(priv));
  }
  const personaText = persona ?? ctx.persona;
  if (personaText) parts.push('Persona: ' + personaText);
  parts.push('Reply with ONLY a short plain-text speech (1-3 sentences) as ' + role.name + '; no JSON.');
  return parts.join('\n');
}

/**
 * Host/MC narration prompt. Includes the live cadence budget (msg/min,
 * a plain number - never a timestamp). Host output is best-effort and
 * must never leak private information.
 */
export function buildHostPrompt(state: EngineState, phase: GamePhase, cadence: number): string {
  const players = state.seats.filter((s) => s.kind !== 'host');
  const alive = players.filter((s) => s.role === undefined || s.role.alive);
  const recent = state.log.filter((e) => e.visibleTo === null).slice(-20);
  const parts: string[] = [];
  parts.push('You are the Host/MC of a Werewolf game. Current phase: ' + phase + '.');
  parts.push('Alive players: ' + renderSeats(alive));
  parts.push('Recent public history:');
  parts.push(renderLog(recent));
  parts.push('Narration cadence: ' + cadence + ' messages/minute. Stay within that budget.');
  parts.push('Reply with ONLY the next narration text (plain text, no JSON). Never reveal private information (roles, seer results, witch usage).');
  return parts.join('\n');
}
