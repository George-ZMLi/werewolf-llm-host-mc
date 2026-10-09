import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { AgentAction, Event, GamePhase, SeatState } from '../engine/types';
import type { ClientMsg, ServerMsg } from './protocol';

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0,
};

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

function makeRoom(): { state: EngineState; orch: Orchestrator } {
  const seats: SeatState[] = [
    { seatId: 's0', kind: 'human', name: 'A' },
    { seatId: 's1', kind: 'human', name: 'B' },
    { seatId: 's2', kind: 'agent', name: 'C' },
  ];
  const state = new EngineState(seats, TIMINGS, createSeededRng(1), () => 1000000);
  const adapter = new SeatAdapter(
    state,
    async () => JSON.stringify({ action: 'pass', targets: [] }),
    async () => ({ action: 'pass', targets: [] }),
  );
  const host = new HostAgent(async () => 'narr', state);
  return { state, orch: new Orchestrator(state, adapter, host, () => {}, () => 1000000) };
}

describe('createWsServer', () => {
  let httpServer: http.Server;
  let handle: WsServerHandle;
  let port: number;
  let state: EngineState;
  let rooms: Map<string, Orchestrator>;
  let routed: Array<[string, string, AgentAction | string]>;
  let onEventCalls: Array<{ roomId: string; e: Event }>;  

  beforeEach(async () => {
    const room = makeRoom();
    state = room.state;
    rooms = new Map([['r1', room.orch]]);
    routed = [];
    onEventCalls = [];
    handle = createWsServer({
      rooms,
      onEvent: (roomId, e) => {
        onEventCalls.push({ roomId, e });
      },
      routeSeatAction: (roomId, seatId, action) => {
        routed.push([roomId, seatId, action]);
        return true;
      },
    });
    httpServer = http.createServer();
    attachHttp(handle, httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await handle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('accepts a join message and emits lobby_update to the room', async () => {
    const c = await makeClient(port);
    c.send({ type: 'join', payload: { roomId: 'r1', seatId: 's0', name: 'A' } });
    const ack = await c.next();
    expect(ack.type).toBe('lobby_update');
    expect(ack.seatId).toBe('s0');
    expect(ack.token).toBeTruthy();
    expect(ack.room?.id).toBe('r1');
    expect(ack.room?.status).toBe('lobby');
    expect(ack.room?.seats).toHaveLength(3);

    // Room full: two different sockets hold s0 and s1; s2 is an agent seat.
    const c2 = await makeClient(port);
    c2.send({ type: 'join', payload: { roomId: 'r1', seatId: 's1' } });
    await c2.next(); // joiner's s1 acknowledgement
    const c3 = await makeClient(port);
    c3.send({ type: 'join', payload: { roomId: 'r1' } });
    const err = await c3.next();
    expect(err.type).toBe('error');
    expect(err.message).toMatch(/full/);
  });

  it('routes seat_action to the orchestrator and emits phase_event back', async () => {
    const c = await makeClient(port);
    c.send({ type: 'join', payload: { roomId: 'r1', seatId: 's0' } });
    await c.next();
    c.send({ type: 'seat_action', payload: { seatId: 's0', action: { action: 'pass', targets: [] } } });
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(routed).toEqual([['r1', 's0', { action: 'pass', targets: [] }]]);

    // A human seat may not act on another seat's behalf.
    const c2 = await makeClient(port);
    c2.send({ type: 'join', payload: { roomId: 'r1', seatId: 's1' } });
    await c2.next();
    c2.send({ type: 'seat_action', payload: { seatId: 's0', action: { action: 'pass', targets: [] } } });
    const err = await c2.next();
    expect(err.type).toBe('error');
    expect(err.message).toMatch(/another seat/);
    await c.next(); // lobby_update announcing c2's join

    // App wiring: engine events flow back through the server broadcast.
    const ev = state.recordEvent('timeout', { seatId: 's0' }, null);
    const delivered = handle.broadcast('r1', { type: 'phase_event', event: ev });
    expect(delivered).toBe(2); // public event reaches both c (s0) and c2 (s1)
    const got = await c.next();
    expect(got.type).toBe('phase_event');
    expect(got.event?.type).toBe('timeout');
    expect(onEventCalls.some((x) => x.roomId === 'r1' && x.e.type === 'timeout')).toBe(true);
  });

  it('honors visibleTo when broadcasting phase_event to specific seats only', async () => {
    const ca = await makeClient(port);
    ca.send({ type: 'join', payload: { roomId: 'r1', seatId: 's0' } });
    await ca.next();
    const cb = await makeClient(port);
    cb.send({ type: 'join', payload: { roomId: 'r1', seatId: 's1' } });
    await cb.next();
    await ca.next(); // lobby_update announcing cb's join

    const privateEv = state.recordEvent('seer_result', { observer: 's1', result: 'werewolf' }, ['s1']);
    const delivered = handle.broadcast('r1', { type: 'phase_event', event: privateEv });
    expect(delivered).toBe(1);
    const got = await cb.next();
    expect(got.type).toBe('phase_event');
    expect(got.event?.type).toBe('seer_result');

    // s0 must not have received the private event.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(ca.msgs.length).toBe(0);

    const publicEv = state.recordEvent('dawn_announcement', { dead: [] }, null);
    handle.broadcast('r1', { type: 'phase_event', event: publicEv });
    const aGot = await ca.next();
    expect(aGot.type).toBe('phase_event');
    expect(aGot.event?.type).toBe('dawn_announcement');
  });

  it('reconnects with a token and receives a re-synced filtered log', async () => {
    const c = await makeClient(port);
    c.send({ type: 'join', payload: { roomId: 'r1', seatId: 's0' } });
    const ack = await c.next();
    const token = ack.token as string;
    c.close();
    await new Promise<void>((r) => setTimeout(r, 50)); // let the server release the seat

    state.recordEvent('player_speech', { seatId: 's0', text: 'hi' }, null);
    state.recordEvent('seer_result', { observer: 's1', result: 'werewolf' }, ['s1']);

    const c2 = await makeClient(port);
    c2.send({ type: 'reconnect', payload: { token } });
    const m1 = await c2.next();
    expect(m1.type).toBe('phase_event');
    expect(m1.event?.type).toBe('player_speech');
    const m2 = await c2.next();
    expect(m2.type).toBe('lobby_update');
    expect(m2.seatId).toBe('s0');
    expect(m2.room?.log).toHaveLength(1);
    expect(m2.room?.log[0].type).toBe('player_speech');
  });
});
