/**
 * Development server (plan task 15): a minimal http server that serves
 * public/ and attaches the task 9 ws server to the same port. Run with
 * `npm run dev` (tsx src/server.ts).
 *
 * LLM wiring via env:
 *   WEREWOLF_LLM_BASE_URL / WEREWOLF_LLM_API_KEY / WEREWOLF_LLM_MODEL
 *   WEREWOLF_VLLM_URL / WEREWOLF_VLLM_MODEL  (local vLLM, no key)
 * With neither set, a safe pass-stub keeps the game deterministic and
 * best-effort (spec section 6).
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWsServer, attachHttp } from './transport/ws-server';
import type { WsServerHandle } from './transport/ws-server';
import { Orchestrator } from './orchestrator';
import { EngineState } from './engine/state';
import { createSeededRng } from './engine/deck';
import { SeatAdapter } from './agents/seat-adapter';
import { HostAgent } from './agents/host-agent';
import { createOpenAICompatibleClient } from './llm/openai-compatible';
import { createLocalVllmClient } from './llm/local-vllm';
import type { LlmClient } from './llm/types';
import type { AgentAction, GamePhase, RoleConfig, SeatState } from './engine/types';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function makeLlmClient(): LlmClient {
  const openaiUrl = process.env.WEREWOLF_LLM_BASE_URL;
  if (openaiUrl) {
    return createOpenAICompatibleClient({
      baseUrl: openaiUrl,
      apiKey: process.env.WEREWOLF_LLM_API_KEY ?? '',
      model: process.env.WEREWOLF_LLM_MODEL ?? 'gpt-4o-mini',
    });
  }
  const vllmUrl = process.env.WEREWOLF_VLLM_URL;
  if (vllmUrl) {
    return createLocalVllmClient({
      baseUrl: vllmUrl,
      model: process.env.WEREWOLF_VLLM_MODEL ?? 'werewolf',
    });
  }
  // Safe deterministic fallback: agent seats pass; host narration falls
  // back to default narration (spec section 6).
  return async () => JSON.stringify({ action: 'pass', targets: [] });
}

interface StartServerResult {
  server: Server;
  handle: WsServerHandle;
  rooms: Map<string, Orchestrator>;
  pushDraft: (roomId: string, seatId: string, action: AgentAction | string) => number;
  close: () => Promise<void>;
}

/**
 * Start the dev server on `port` with a default room (mixed 3 human +
 * 2 agent seats, standard role config). Human seat_actions resolve the
 * seat's pending humanSubmit; `pushDraft` broadcasts llm_draft messages
 * (spec section 7) to the room - each client shows the overlay only for
 * a draft addressed to the seat it controls.
 */
export async function startServer(port: number = Number(process.env.WEREWOLF_PORT ?? 8080)): Promise<StartServerResult> {
  const roles: RoleConfig[] = JSON.parse(await readFile(join(dataDir, 'roles-standard.json'), 'utf8'));
  const timings = JSON.parse(await readFile(join(dataDir, 'timings-default.json'), 'utf8')) as {
    budgetMs: Record<GamePhase, number>;
  };
  const llm = makeLlmClient();

  // Pending human submissions, keyed by seatId (one turn in flight at a time).
  const pending = new Map<string, (v: AgentAction | string) => void>();
  const rooms = new Map<string, Orchestrator>();
  let handle: WsServerHandle | null = null;

  // Six seats satisfy the standard config minimum (2 werewolves + seer +
  // witch + hunter + villager). Three human seats, three agent seats.
  const seats: SeatState[] = [
    { seatId: 's0', kind: 'human', name: 'Player 1' },
    { seatId: 's1', kind: 'human', name: 'Player 2' },
    { seatId: 's2', kind: 'agent', name: 'Agent 1' },
    { seatId: 's3', kind: 'agent', name: 'Agent 2' },
    { seatId: 's4', kind: 'human', name: 'Player 3' },
    { seatId: 's5', kind: 'agent', name: 'Agent 3' },
  ];
  const state = new EngineState(seats, timings.budgetMs, createSeededRng(Number(process.env.WEREWOLF_SEED ?? 7)), () => Date.now());
  const adapter = new SeatAdapter(
    state,
    llm,
    (seatId) => new Promise((resolve) => { pending.set(seatId, resolve); }),
  );
  const host = new HostAgent(llm, state);
  const orch = new Orchestrator(
    state,
    adapter,
    host,
    (e) => {
      if (handle) handle.broadcast('default', { type: 'phase_event', event: e });
    },
    () => Date.now(),
  );
  rooms.set('default', orch);

  handle = createWsServer({
    rooms,
    onEvent: () => {},
    routeSeatAction: (_roomId, seatId, action) => {
      const resolve = pending.get(seatId);
      if (!resolve) return false;
      pending.delete(seatId);
      resolve(action);
      return true;
    },
  });

  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const abs = join(publicDir, rel);
    if (!abs.startsWith(publicDir)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  attachHttp(handle, server);
  server.listen(port);

  // Minimal lobby-to-game flow: start the game immediately; late human
  // joins still get a seat and act during their turn.
  await orch.start(roles);

  return {
    server,
    handle,
    rooms,
    pushDraft: (roomId, seatId, action) =>
      handle!.broadcast(roomId, { type: 'llm_draft', draft: { seatId, action } }),
    close: async () => {
      await handle!.close();
      server.close();
    },
  };
}

// Auto-start when executed directly (tsx src/server.ts), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then((r) => {
    console.log('werewolf dev server listening (http + ws)');
    void r;
  });
}