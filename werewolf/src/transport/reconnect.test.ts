/**
 * Reconnection visibility integration test (plan task 16):
 * a real Orchestrator + createWsServer. The game deals its roles (private
 * role_assigned events); a dropped client reconnects with its token and
 * must resync with only the events visible to its own seat.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { createWsServer, attachHttp } from './ws-server';
import type { WsServerHandle } from './ws-server';
import { Orchestrator } from '../orchestrator';
import { EngineState } from '../engine/state';
import { createSeededRng } from '../engine/deck';
import { SeatAdapter } from '../agents/seat-adapter';
import { HostAgent } from '../agents/host-agent';
import type { Event, GamePhase, RoleConfig, SeatState } from '../engine/types';
import type { ClientMsg, ServerMsg } from './protocol';
import { createSeededMockLlm } from '../../tests/helpers/mock-llm';

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0,
};

const ROLES: RoleConfig[] = [
  { id: 'werewolf', name: '狼人', faction: 'villain', min: 2, max: 2, night: { order: 1, action: 'target_player', targets: 1, maxTargets: 1, promptTemplateId: 'werewolf_night' } },
  { id: 'seer', name: '预言家', faction: 'villager', min: 1, max: 1, night: { order: 2, action: 'observe', targets: 1, maxTargets: 1, promptTemplateId: 'seer_night' } },
  { id: 'witch', name: '女巫', faction: 'villager', min: 1, max: 1, night: { order: 3, action: 'protect', targets: 1, maxTargets: 1, promptTemplateId: 'witch_night' } },
  { id: 'hunter', name: '猎人', faction: 'villager', min: 1, max: 1, day: { action: 'speak', promptTemplateId: 'hunter_day' } },
  { id: 'villager', name: '村民', faction: 'villager', min: 1, max: 8, day: { action: 'speak', promptTemplateId: 'villager_day' } },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestClient {
  sock: WsClient;
  msgs: ServerMsg[];
  next: (timeoutMs?: number) => Promise<ServerMsg>;
  send: (m: ClientMsg) => void;
  close: () => void;
}

function makeClient(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const sock = new WsClient('ws://127.0.0.1:' + port);
    const client: TestClient = {
      sock,
      msgs: [],
      next: (timeoutMs = 3000) =>
        new Promise((res, rej) => {
          const start = Date.now();
          const t = setInterval(() => {
            if (client.msgs.length > 0) {
              clearInterval(t);
              res(client.msgs.shift() as ServerMsg);
            } else if (Date.now() - start > timeoutMs) {
              clearInterval(t);
              rej(new Error('timeout waiting for server message'));
            }
          }, 5);
        }),
      send: (m) => sock.send(JSON.stringify(m)),
      close: () => sock.close(),
    };
    sock.on('message', (data) => client.msgs.push(JSON.parse(String(data)) as ServerMsg));
    sock.on('open', () => resolve(client));
    sock.on('error', reject);
  });
}

describe('reconnect visibility (task 16)', () => {
  let httpServer: http.Server;
  let handle: WsServerHandle;
  let port: number;
  let state: EngineState;
  let orch: Orchestrator;
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await handle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function setup(): Promise<void> {
    state = new EngineState(
      [
        { seatId: 's0', kind: 'human', name: 'A' },
        { seatId: 's1', kind: 'agent', name: 'Agent 1' },
        { seatId: 's2', kind: 'human', name: 'B' },
        { seatId: 's3', kind: 'agent', name: 'Agent 2' },
        { seatId: 's4', kind: 'human', name: 'C' },
        { seatId: 's5', kind: 'agent', name: 'Agent 3' },
      ],
      TIMINGS,
      createSeededRng(7),
      () => 1000000,
    );
    const adapter = new SeatAdapter(
      state,
      createSeededMockLlm(999),
      async () => {
        await sleep(50);
        return { action: 'pass' as const, targets: [] as string[] };
      },
    );
    const host = new HostAgent(async () => 'narration', state);
    const rooms = new Map<string, Orchestrator>();
    handle = createWsServer({
      rooms,
      onEvent: () => {},
      routeSeatAction: () => false,
    });
    orch = new Orchestrator(
      state,
      adapter,
      host,
      (e: Event) => {
        handle.broadcast('r1', { type: 'phase_event', event: e });
      },
      () => 1000000,
    );
    rooms.set('r1', orch);
    httpServer = http.createServer();
    attachHttp(handle, httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  }

  it('resyncs a reconnected seat with only the events visible to it', async () => {
    await setup();
    const c1 = await makeClient(port); clients.push(c1);
    const c2 = await makeClient(port); clients.push(c2);
    const c3 = await makeClient(port); clients.push(c3);
    c1.send({ type: 'join', payload: { roomId: 'r1', name: 'Alice' } });
    c2.send({ type: 'join', payload: { roomId: 'r1', name: 'Bob' } });
    c3.send({ type: 'join', payload: { roomId: 'r1', name: 'Carol' } });
    await sleep(50);

    const bindings: { client: TestClient; seatId: string; token: string }[] = [];
    for (const c of [c1, c2, c3]) {
      const ack = c.msgs.find((m) => m.type === 'lobby_update' && typeof m.token === 'string');
      expect(ack, 'client received a join acknowledgement with a reconnection token').toBeDefined();
      const a = ack as ServerMsg;
      bindings.push({ client: c, seatId: a.seatId as string, token: a.token as string });
    }

    await orch.start(ROLES);
    await sleep(50);

    // Live broadcasts: each original socket saw only the role cards it may see.
    const wolves = state.seats.filter((s) => s.role?.faction === 'villain').map((s) => s.seatId);
    for (const b of bindings) {
      const cards = b.client.msgs.filter((m) => m.type === 'phase_event' && m.event?.type === 'role_assigned');
      const allowed = wolves.includes(b.seatId) ? wolves : [b.seatId];
      expect(cards, 'role cards seen by ' + b.seatId).toHaveLength(allowed.length);
      for (const m of cards) {
        expect(allowed, b.seatId + ' must not see ' + m.event?.payload.seatId + ' role card').toContain(m.event?.payload.seatId as string);
      }
    }

    // Pick a non-wolf, non-seer human seat: it must see exactly one role card (its own).
    const pick = state.seats.find(
      (s) => s.kind === 'human' && s.role !== undefined && s.role.roleId !== 'seer' && s.role.faction !== 'villain',
    );
    expect(pick, 'a non-wolf non-seer human seat exists').toBeDefined();
    const seatId = (pick as SeatState).seatId;
    const binding = bindings.find((b) => b.seatId === seatId) as { client: TestClient; seatId: string; token: string };
    binding.client.close();
    await sleep(50); // let the server release the seat claim

    const cr = await makeClient(port);
    clients.push(cr);
    cr.send({ type: 'reconnect', payload: { token: binding.token } });

    const events: Event[] = [];
    let lobby: ServerMsg | null = null;
    for (let i = 0; i < 50; i++) {
      const m = await cr.next();
      if (m.type === 'phase_event') {
        events.push(m.event as Event);
        continue;
      }
      if (m.type === 'lobby_update') {
        lobby = m;
        break;
      }
      if (m.type === 'error') throw new Error('server error during resync: ' + m.message);
    }
    expect(lobby, 'resync ends with a lobby_update carrying the room snapshot').not.toBeNull();

    for (const e of events) {
      expect(e.visibleTo === null || e.visibleTo.includes(seatId), 'event ' + e.type + ' is visible to ' + seatId).toBe(true);
    }
    const cards = events.filter((e) => e.type === 'role_assigned');
    expect(cards, 'exactly one role card in the resync').toHaveLength(1);
    expect((cards[0].payload as Record<string, unknown>).seatId).toBe(seatId);
    expect(cards[0].visibleTo).toEqual([seatId]);
    expect(events.some((e) => e.type === 'game_dealt')).toBe(true);
    expect(events.some((e) => e.type === 'phase_change' && (e.payload as Record<string, unknown>).phase === 'night')).toBe(true);
    expect((lobby as ServerMsg).room?.log).toHaveLength(events.length);
  });

  it('rejects an unknown reconnection token', async () => {
    await setup();
    const c = await makeClient(port);
    clients.push(c);
    c.send({ type: 'reconnect', payload: { token: 'not-a-token' } });
    const m = await c.next();
    expect(m.type).toBe('error');
    expect(m.message).toBe('unknown reconnection token');
  });
});
