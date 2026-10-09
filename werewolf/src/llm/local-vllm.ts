/**
 * Local vLLM adapter (plan task 11).
 *
 * A self-hosted vLLM server exposes the OpenAI chat-completions API and
 * needs no API key, so this is the OpenAI-compatible client with the
 * authorization header suppressed.
 */
import { createOpenAICompatibleClient } from './openai-compatible';
import type { LlmClient } from './types';

export interface LocalVllmOptions {
  /** e.g. http://127.0.0.1:8000/v1 */
  baseUrl: string;
  model: string;
}

/**
 * Build a LlmClient bound to a local vLLM server.
 */
export function createLocalVllmClient(opts: LocalVllmOptions): LlmClient {
  return createOpenAICompatibleClient({ baseUrl: opts.baseUrl, apiKey: '', model: opts.model });
}
