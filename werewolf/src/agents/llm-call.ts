import Ajv from 'ajv';
import { createSeededRng } from '../engine/deck';
import type { AgentAction, AgentPromptContext, Event } from '../engine/types';
import type { LlmClient } from '../llm/types';

/**
 * Deterministic LLM decision wrapper (spec section 3, plan task 4):
 *  - temperature is always 0,
 *  - strict-JSON response validated with ajv,
 *  - one retry with the validation error fed back,
 *  - on second failure / timeout: safe default (pass, or a random legal target
 *    for target_player roles seeded by now()) - the game never stalls,
 *  - a fallback is reported via opts.onFallback so the orchestrator can
 *    record the agent_fallback event.
 */

/** The decision schema every night/voting prompt asks the LLM to satisfy. */
export const DECISION_SCHEMA = {
  type: 'object',
  required: ['action', 'targets'],
  properties: {
    action: { type: 'string', enum: ['target_player', 'protect', 'observe', 'pass'] },
    targets: { type: 'array', items: { type: 'string' }, maxItems: 4, uniqueItems: true },
    speech: { type: 'string', maxLength: 500 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const;

export const DECISION_SCHEMA_JSON = JSON.stringify(DECISION_SCHEMA);

type Validator = (data: unknown) => boolean;
const validatorCache = new Map<string, Validator>();

function compileSchema(schema: string | object): Validator {
  const key = typeof schema === 'string' ? schema : JSON.stringify(schema);
  let v = validatorCache.get(key);
  if (!v) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schemaObj = typeof schema === 'string' ? (JSON.parse(schema) as object) : schema;
    v = ajv.compile(schemaObj);
    validatorCache.set(key, v);
  }
  return v;
}

/** Strip the ts field so prompts never carry a numeric wall-clock. */
function stripEvent(e: Event): Record<string, unknown> {
  const { ts: _ts, ...rest } = e;
  return rest;
}

/**
 * Default prompt builder: role, persona, alive seats, public log, private log.
 * Never includes a wall-clock timestamp (spec section 3 constraint).
 */
export function buildDefaultPrompt(ctx: AgentPromptContext): string {
  const lines: string[] = [];
  lines.push('You are an LLM player in a werewolf (狼人杀) game.');
  lines.push('Your role: ' + ctx.role.name + ' (' + ctx.role.id + ') - faction: ' + ctx.role.faction + '.');
  if (ctx.persona) lines.push('Persona: ' + ctx.persona);
  lines.push('');
  lines.push('Alive seats: ' + ctx.aliveSeats.map((s) => s.seatId + '(' + s.name + ')').join(', '));
  lines.push('');
  lines.push('Public log:');
  if (ctx.publicLog.length === 0) lines.push('- (empty)');
  for (const e of ctx.publicLog) {
    lines.push('- [phase=' + e.phase + '] ' + e.type + ': ' + JSON.stringify(stripEvent(e)));
  }
  if (ctx.privateLog.length > 0) {
    lines.push('Private information for you only:');
    for (const e of ctx.privateLog) {
      lines.push('- [phase=' + e.phase + '] ' + e.type + ': ' + JSON.stringify(stripEvent(e)));
    }
  }
  lines.push('');
  lines.push('Respond with a single JSON object only:');
  lines.push('{ "action": "target_player|protect|observe|pass", "targets": ["<seatId>"], "speech": "<say aloud>", "confidence": 0.0 }');
  return lines.join('\n');
}

function parseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

function normalizeDecision(parsed: unknown, ctx: AgentPromptContext): AgentAction | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const legalActions = ['target_player', 'protect', 'observe', 'pass'];
  if (typeof p.action !== 'string' || !legalActions.includes(p.action)) return null;
  if (!Array.isArray(p.targets)) return null;
  const aliveIds = new Set(ctx.aliveSeats.map((s) => s.seatId));
  for (const t of p.targets) {
    if (typeof t !== 'string') return null;
    if (!aliveIds.has(t) && t !== ctx.selfSeatId) return null;
  }
  const action: AgentAction = {
    action: p.action as AgentAction['action'],
    targets: [...(p.targets as string[])],
  };
  if (typeof p.speech === 'string') action.speech = p.speech;
  if (typeof p.confidence === 'number') action.confidence = p.confidence;
  return action;
}

/** Spec section 3 fallback: pass, or a random legal target for target_player roles. */
export function safeDefault(ctx: AgentPromptContext, rng: () => number): AgentAction {
  const night = ctx.role.night;
  if (!night || night.action === 'pass') {
    return { action: 'pass', targets: [], speech: '' };
  }
  if (night.action === 'target_player') {
    const candidates = ctx.aliveSeats.filter((s) => s.seatId !== ctx.selfSeatId);
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      return { action: 'target_player', targets: [pick.seatId], speech: '' };
    }
  }
  return { action: 'pass', targets: [], speech: '' };
}

/** Race a promise against a (virtual) timer; resolves undefined on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export interface CallAgentOptions {
  /** Seeded rng for the fallback's random target. Defaults to seed = floor(now()/1000). */
  rng?: () => number;
  /** Extra instruction fed into the first attempt (e.g. previous error). */
  errorNote?: string;
  /** Called (once) when the fallback path is taken, with the reason. */
  onFallback?: (reason: string) => void;
}

export interface AgentDecisionResult {
  decision: AgentAction;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

/**
 * Call the LLM once, retry once with the validation error, then fall back to
 * a safe default. Never throws; bounded by ~2*timeoutMs.
 */
export async function callAgentDecision(
  client: LlmClient,
  ctx: AgentPromptContext,
  schema: string,
  now: () => number,
  timeoutMs = 30000,
  opts: CallAgentOptions = {},
): Promise<AgentDecisionResult> {
  const validate = compileSchema(schema);
  const basePrompt = buildDefaultPrompt(ctx);
  let attemptPrompt = opts.errorNote ? basePrompt + '\n\n' + opts.errorNote : basePrompt;
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await withTimeout(client(attemptPrompt, { temperature: 0, schema }), timeoutMs);
    if (raw === undefined) {
      return fallback(ctx, opts, now, 'llm timeout');
    }
    let parsed: unknown;
    try {
      parsed = parseJson(raw);
    } catch (err) {
      lastError = 'invalid JSON: ' + String(err);
      attemptPrompt = basePrompt + retryNote(lastError);
      continue;
    }
    if (!validate(parsed)) {
      lastError = 'response failed schema validation';
      attemptPrompt = basePrompt + retryNote(lastError);
      continue;
    }
    const decision = normalizeDecision(parsed, ctx);
    if (decision === null) {
      lastError = 'decision references unknown or illegal seats';
      attemptPrompt = basePrompt + retryNote(lastError);
      continue;
    }
    return { decision, fallbackUsed: false };
  }

  return fallback(ctx, opts, now, lastError || 'llm error');
}

function retryNote(reason: string): string {
  return '\nYour previous response was invalid (' + reason + '). Respond with a single strict-JSON object only.';
}

function fallback(ctx: AgentPromptContext, opts: CallAgentOptions, now: () => number, reason: string): AgentDecisionResult {
  const rng = opts.rng ?? createSeededRng(Math.floor(now() / 1000));
  const decision = safeDefault(ctx, rng);
  opts.onFallback?.(reason);
  return { decision, fallbackUsed: true, fallbackReason: reason };
}
