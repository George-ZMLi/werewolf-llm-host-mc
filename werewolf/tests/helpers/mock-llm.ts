/**
 * Deterministic mock LLM client for integration tests (plan task 16).
 *
 * createSeededMockLlm(seed) returns an LlmClient that is:
 *  - stateless and order-independent: each call seeds a fresh mulberry32 PRNG
 *    from (seed ^ djb2(prompt)), so interleaved host/player calls can never
 *    change any other call's output,
 *  - host prompts (narration / nudges) -> a fixed string,
 *  - speech prompts (opts.schema === undefined, non-host) -> a plain-text
 *    remark picked from a fixed list, never JSON,
 *  - decision prompts (schema present) -> strict JSON matching
 *    DECISION_SCHEMA, chosen from a deterministic strategy that always
 *    terminates a standard 6-seat game:
 *      night:  werewolf kills the lowest alive seat, seer checks the lowest,
 *              witch saves the lowest (self-targets are rejected by the
 *              engine -> action_rejected, still deterministic),
 *      voting: every seat lynches the highest alive seat (self-votes are
 *              rejected by the engine) -> alive count shrinks by one per day
 *              until exactly one seat survives, so checkWin always fires.
 * It never throws and never falls through to the wall-clock fallback.
 */
import { createSeededRng } from '../../src/engine/deck';
import type { LlmClient } from '../../src/llm/types';

const SPEECHES = [
  'I have no private information, but I will follow the evidence of the seer.',
  'Watch who hesitates when the vote comes; hesitation is a tell.',
  'Trust the public record and the host\'s announcements before you accuse.',
  'I will not accuse blindly; let the discussion decide who stands out.',
];

const NARRATION = 'The host announces that the phase has changed and the game continues.';

/** djb2 string hash (unsigned 32-bit). */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function createSeededMockLlm(seed: number): LlmClient {
  return async (prompt, opts) => {
    const rng = createSeededRng((seed ^ djb2(prompt)) >>> 0);

    if (prompt.startsWith('You are the game host')) {
      return NARRATION;
    }

    if (opts.schema === undefined) {
      // Day-speech prompt: plain text, never JSON.
      return SPEECHES[Math.floor(rng() * SPEECHES.length)];
    }

    // Decision prompt (buildDefaultPrompt).
    const roleMatch = prompt.match(/Your role: .* \((\w+)\)/);
    const roleId = roleMatch ? roleMatch[1] : 'villager';
    const aliveLine = prompt.split('\n').find((l) => l.startsWith('Alive seats:')) ?? '';
    const alive = (aliveLine.match(/s\d+/g) ?? []).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const lowest = alive.length > 0 ? alive[0] : '';
    const highest = alive.length > 0 ? alive[alive.length - 1] : '';

    const markers = prompt.match(/\[phase=([a-z_]+)\]/g) ?? [];
    let lastPhase = '';
    if (markers.length > 0) {
      const mm = markers[markers.length - 1].match(/phase=([a-z_]+)/);
      if (mm) lastPhase = mm[1];
    }

    let action: 'target_player' | 'protect' | 'observe' | 'pass' = 'pass';
    let targets: string[] = [];
    if (lastPhase === 'night') {
      if (roleId === 'werewolf' && lowest) { action = 'target_player'; targets = [lowest]; }
      else if (roleId === 'seer' && lowest) { action = 'observe'; targets = [lowest]; }
      else if (roleId === 'witch' && lowest) { action = 'protect'; targets = [lowest]; }
    } else if ((lastPhase === 'voting' || lastPhase === 'day_discussion') && highest) {
      action = 'target_player';
      targets = [highest];
    }

    const confidence = Math.floor(rng() * 100) / 100;
    return JSON.stringify({ action, targets, confidence });
  };
}
