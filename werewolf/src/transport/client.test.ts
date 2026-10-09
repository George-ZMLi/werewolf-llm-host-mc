import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWsServer, attachHttp } from './ws-server';
import type { WsServerHandle } from './ws-server';
import { WerewolfClient } from './client';
import { Orchestrator } from '../orchestrator';
import { EngineState } from '../engine/state';
import { createSeededRng } from '../engine/deck';
import { SeatAdapter } from '../agents/seat-adapter';
import { HostAgent } from '../agents/host-agent';
import type { AgentAction, Event, GamePhase, SeatState } from '../engine/types';
import type { ServerMsg } from './protocol';

const TIMINGS: Record<GamePhase, number> = {
  lobby: 0, night: 120000, dawn: 30000, day_discussion: 180000, voting: 90000, finished: 0,
};

function once(client: WerewolfClient, type: string, timeoutMs = 3000): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error('timeout waiting for ' + type));
    }, timeoutMs);
    const off = client.on(type, (data) => {
      clearTimeout(t);
      off();
      resolve(data as ServerMsg);
    });
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

describe('WerewolfClient', () => {
  let httpServer: http.Server;
  let handle: WsServerHandle;
  let port: number;
  let state: EngineState;
  let routed: Array<[string, string, AgentAction | string]>;
  const clients: WerewolfClient[] = [];

  beforeEach(async () => {
    const room = makeRoom();
    state = room.state;
    routed = [];
    handle = createWsServer({
      rooms: new Map([['r1', room.orch]]),
      onEvent: (_roomId: string, _e: Event) => {},
      routeSeatAction: (roomId, seatId, action) => {
        routed.push([roomId, seatId, action]);
        // Accept structured AgentActions; reject plain strings so the server can
        // answer with an 'action not accepted' error message.
        return typeof action === 'object' && action !== null;
      },
    });
    httpServer = http.createServer();
    attachHttp(handle, httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await handle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function makeClient(): WerewolfClient {
    const client = new WerewolfClient('ws://127.0.0.1:' + port);
    clients.push(client);
    return client;
  }

  it('connects and joins a room, returning a seatId', async () => {
    const client = makeClient();
    const seatId = await client.join('r1', 'Alice');
    expect(seatId).toBe('s0');
    expect(client.token).toBeTruthy();

    // A second joiner triggers a lobby_update on the first client.
    const other = makeClient();
    await other.join('r1', 'Bob');
    const lobby = await once(client, 'lobby_update');
    expect(lobby.room?.status).toBe('lobby');
    expect(lobby.room?.seats).toHaveLength(3);
  });

  it('sends seat_action and resolves on server ack', async () => {
    const client = makeClient();
    await client.join('r1', 'Alice', 's0');
    await client.send({ action: 'pass', targets: [] });
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(routed).toEqual([['r1', 's0', { action: 'pass', targets: [] }]]);

    // A rejected action surfaces as an error message from the server.
    const err = once(client, 'error');
    await client.send('speech text');
    const got = await err;
    expect(got.type).toBe('error');
  });

  it('reconnects with a token and receives a re-synced filtered log', async () => {
    const client = makeClient();
    const seatId = await client.join('r1', 'Alice', 's0');
    expect(seatId).toBe('s0');
    await client.close();

    state.recordEvent('player_speech', { seatId: 's0', text: 'hi' }, null);
    state.recordEvent('seer_result', { observer: 's1', result: 'werewolf' }, ['s1']);

    const c2 = makeClient();
    // Subscribe before reconnecting: the re-sync burst (phase_events followed
    // by the final lobby_update) is emitted during the reconnect() handshake
    // itself, so both listeners must be registered beforehand.
    const evP = once(c2, 'phase_event');
    const lobbyP = once(c2, 'lobby_update');
    await c2.reconnect(client.token as string);
    const ev = await evP;
    expect(ev.type).toBe('phase_event');
    expect(ev.event?.type).toBe('player_speech');
    const lobby = await lobbyP;
    expect(lobby.seatId).toBe('s0');
    expect(lobby.room?.log).toHaveLength(1); // s1-only private event filtered out
  });
});
