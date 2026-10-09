import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleClient } from './openai-compatible';
import { createLocalVllmClient } from './local-vllm';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createOpenAICompatibleClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the chat-completions endpoint with temperature 0', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '{"action":"pass"}' } }] }),
    );
    const client = createOpenAICompatibleClient({ baseUrl: 'https://api.example.com/v1/', apiKey: 'k1', model: 'm1' });
    const out = await client('say hi', { temperature: 0, schema: '{"type":"object"}' });
    expect(out).toBe('{"action":"pass"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>;
    expect(body.model).toBe('m1');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'say hi' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toBe('Bearer k1');
  });

  it('omits response_format when no schema is requested', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createOpenAICompatibleClient({ baseUrl: 'https://api.example.com', apiKey: 'k1', model: 'm1' });
    await client('p', { temperature: 0 });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
  });

  it('propagates HTTP errors as thrown errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = createOpenAICompatibleClient({ baseUrl: 'https://api.example.com', apiKey: 'k1', model: 'm1' });
    await expect(client('p', { temperature: 0 })).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the response lacks message content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    const client = createOpenAICompatibleClient({ baseUrl: 'https://api.example.com', apiKey: 'k1', model: 'm1' });
    await expect(client('p', { temperature: 0 })).rejects.toThrow(/missing choices\[0\]\.message\.content/);
  });
});

describe('createLocalVllmClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the vLLM chat-completions endpoint without an auth header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const client = createLocalVllmClient({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen2.5-7b' });
    const out = await client('p', { temperature: 0 });
    expect(out).toBe('hi');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:8000/v1/chat/completions');
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers['Authorization']).toBeUndefined();
  });
});
