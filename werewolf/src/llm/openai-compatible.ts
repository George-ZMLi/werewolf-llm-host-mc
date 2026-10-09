/**
 * OpenAI-compatible chat-completions adapter (plan task 11).
 *
 * Works against any server exposing POST {baseUrl}/chat/completions
 * (OpenAI, vLLM, LiteLLM, ...). Temperature is pinned to 0 for
 * determinism (spec §5); a schema hint is mapped to
 * response_format json_object. Non-2xx responses throw - the caller
 * (callAgentDecision) performs its retry and safe-default fallback.
 */
import type { LlmClient } from './types';

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1 - a trailing slash is tolerated. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LlmChatOptions {
  temperature: number;
  schema?: string;
}

async function chatOnce(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  prompt: string,
  opts: LlmChatOptions,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body: Record<string, unknown> = {
    model,
    // Determinism (spec §5): always sample at temperature 0 regardless of opts.
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.schema !== undefined) body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== null && apiKey !== '') headers['Authorization'] = 'Bearer ' + apiKey;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('llm request failed: HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('llm response missing choices[0].message.content');
  }
  return content;
}

/**
 * Build a LlmClient bound to an OpenAI-compatible chat-completions endpoint.
 */
export function createOpenAICompatibleClient(opts: OpenAICompatibleOptions): LlmClient {
  const { baseUrl, apiKey, model } = opts;
  return (prompt, callOpts) => chatOnce(baseUrl, apiKey, model, prompt, callOpts);
}
