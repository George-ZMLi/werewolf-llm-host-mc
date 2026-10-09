/**
 * WebSocket game server (plan task 9).
 *
 * Keeps a Map of connection state (socket -> { roomId, seatId, token }).
 * join assigns a human seat (rejecting when the room is full) and emits
 * lobby_update. seat_action is routed to the room's pending humanSubmit via
 * the injected routeSeatAction bridge (plan task 7). broadcast filters
 * phase_event by Event.visibleTo and lobby_update logs per recipient.
 * reconnect(token) re-syncs the client with the full state.log filtered by
 * that seat's visibility.
 */
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Orchestrator } from '../orchestrator';
import type { AgentAction, Event, RoomState, SeatState } from '../engine/types';
import type { ClientMsg, ServerMsg } from './protocol';

/** Routes a human seat_action to the room's pending humanSubmit (task 7). Return false to reject. */
export type SeatActionRouter = (roomId: string, seatId: string, action: AgentAction | string) => boolean;

export interface WsServerOptions {
  /** Live game rooms keyed by room id (plan tasks 1-8). */
  rooms: Map<string, Orchestrator>;
  /** Observability hook: called for every delivered phase_event and recorded chat event. */
  onEvent: (roomId: string, e: Event) => void;
  /** Optional bridge delivering human seat_actions to the room's pending humanSubmit. */
  routeSeatAction?: SeatActionRouter;
}

export interface WsServerHandle {
  /** The ws server (noServer mode); attach it with attachHttp(). */
  server: WebSocketServer;
  /**
   * Broadcast a message to a room. phase_event messages are filtered by
   * Event.visibleTo (set -> only the matching seats' sockets; null -> all)
   * and lobby_update logs are filtered per recipient. Returns the number of
   * sockets that received the message.
   */
  broadcast: (roomId: string, msg: ServerMsg, seatId?: string) => number;
  /** Close every client socket and shut down the ws server. */
  close: () => Promise<void>;
}

interface Conn {
  roomId: string | null;
  seatId: string | null;
  token: string | null;
}

function canSee(seatId: string | null, e: Event): boolean {
  return e.visibleTo === null || (seatId !== null && e.visibleTo.includes(seatId));
}

/**
 * Create the noServer ws server and its room-aware message handling.
 * Attach the returned handle to an HTTP server with attachHttp().
 */
export function createWsServer(opts: WsServerOptions): WsServerHandle {
  const server = new WebSocketServer({ noServer: true });
  const conns = new Map<WebSocket, Conn>();
  /** room/seat -> the socket currently holding the seat. */
  const claims = new Map<string, WebSocket>();
  /** reconnection token -> the seat binding it was issued for. */
  const tokens = new Map<string, { roomId: string; seatId: string }>();
  const claimKey = (roomId: string, seatId: string) => roomId + '/' + seatId;

  function send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendErr(ws: WebSocket, message: string): void {
    send(ws, { type: 'error', message });
  }

  function snapshot(roomId: string, seatId: string | null): RoomState {
    const orch = opts.rooms.get(roomId);
    if (!orch) throw new Error('unknown room ' + roomId);
    const st = orch.state;
    return {
      id: roomId,
      status: st.phase === 'lobby' ? 'lobby' : st.phase === 'finished' ? 'finished' : 'playing',
      hostConfig: {},
      seats: st.seats,
      log: st.log.filter((e) => canSee(seatId, e)),
      startedAt: st.phaseStartedAt,
      endedAt: st.winner !== null ? st.phaseStartedAt : undefined,
    };
  }

  function releaseClaim(c: Conn, ws: WebSocket): void {
    if (c.roomId !== null && c.seatId !== null) {
      const k = claimKey(c.roomId, c.seatId);
      if (claims.get(k) === ws) claims.delete(k);
    }
  }

  function sendLobby(roomId: string, except?: WebSocket): void {
    for (const [ws, c] of conns) {
      if (c.roomId !== roomId) continue;
      if (except !== undefined && ws === except) continue;
      send(ws, { type: 'lobby_update', room: snapshot(roomId, c.seatId) });
    }
  }

  function resync(ws: WebSocket, c: Conn): void {
    const orch = opts.rooms.get(c.roomId as string);
    if (!orch) return;
    for (const e of orch.state.log) {
      if (canSee(c.seatId, e)) send(ws, { type: 'phase_event', event: e });
    }
    send(ws, {
      type: 'lobby_update',
      room: snapshot(c.roomId as string, c.seatId),
      seatId: c.seatId ?? undefined,
      token: c.token ?? undefined,
    });
  }

  function doJoin(ws: WebSocket, c: Conn, p: Record<string, unknown>): void {
    const roomId = typeof p.roomId === 'string' ? p.roomId : null;
    if (!roomId || !opts.rooms.has(roomId)) {
      sendErr(ws, 'unknown room');
      return;
    }
    releaseClaim(c, ws);
    const seatId = typeof p.seatId === 'string' ? p.seatId : null;
    const orch = opts.rooms.get(roomId) as Orchestrator;
    let seat: SeatState | undefined =
      seatId !== null ? orch.state.seats.find((s) => s.seatId === seatId && s.kind === 'human') : undefined;
    if (seatId !== null && !seat) {
      sendErr(ws, 'unknown or non-human seat');
      return;
    }
    if (!seat) {
      seat = orch.state.seats.find((s) => s.kind === 'human' && claims.get(claimKey(roomId, s.seatId)) === undefined);
    }
    if (!seat) {
      sendErr(ws, 'room full: no free human seat');
      return;
    }
    c.roomId = roomId;
    c.seatId = seat.seatId;
    c.token = randomUUID();
    tokens.set(c.token, { roomId, seatId: seat.seatId });
    claims.set(claimKey(roomId, seat.seatId), ws);
    send(ws, { type: 'lobby_update', room: snapshot(roomId, c.seatId), seatId: c.seatId, token: c.token });
    sendLobby(roomId, ws);
  }

  function doReconnect(ws: WebSocket, c: Conn, p: Record<string, unknown>): void {
    const token = typeof p.token === 'string' ? p.token : null;
    const prev = token !== null ? tokens.get(token) : undefined;
    if (!prev) {
      sendErr(ws, 'unknown reconnection token');
      return;
    }
    releaseClaim(c, ws);
    c.roomId = prev.roomId;
    c.seatId = prev.seatId;
    c.token = token;
    claims.set(claimKey(prev.roomId, prev.seatId), ws);
    resync(ws, c);
  }

  function doSeatAction(ws: WebSocket, c: Conn, p: Record<string, unknown>): void {
    if (c.roomId === null || c.seatId === null) {
      sendErr(ws, 'not seated');
      return;
    }
    if (typeof p.seatId !== 'string' || p.seatId !== c.seatId) {
      sendErr(ws, 'cannot act for another seat');
      return;
    }
    const action = p.action;
    if (typeof action !== 'string' && (typeof action !== 'object' || action === null)) {
      sendErr(ws, 'invalid action payload');
      return;
    }
    if (!opts.routeSeatAction) {
      sendErr(ws, 'no human routing for this room');
      return;
    }
    if (!opts.routeSeatAction(c.roomId, c.seatId, action as AgentAction | string)) {
      sendErr(ws, 'action not accepted');
    }
  }

  function doChat(ws: WebSocket, c: Conn, p: Record<string, unknown>): void {
    if (c.roomId === null || c.seatId === null) {
      sendErr(ws, 'not seated');
      return;
    }
    const orch = opts.rooms.get(c.roomId);
    if (!orch) {
      sendErr(ws, 'unknown room');
      return;
    }
    const text = typeof p.text === 'string' ? p.text : '';
    const e = orch.state.recordEvent('chat', { seatId: c.seatId, text }, null);
    opts.onEvent(c.roomId, e);
    broadcast(c.roomId, { type: 'chat', event: e });
  }

  function doLeave(ws: WebSocket, c: Conn): void {
    releaseClaim(c, ws);
    c.roomId = null;
    c.seatId = null;
    send(ws, { type: 'lobby_update', message: 'left' });
  }

  function handleMessage(ws: WebSocket, c: Conn, data: unknown): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      sendErr(ws, 'invalid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
      sendErr(ws, 'malformed message');
      return;
    }
    const p = typeof msg.payload === 'object' && msg.payload !== null ? msg.payload : {};
    switch (msg.type) {
      case 'join': doJoin(ws, c, p); break;
      case 'reconnect': doReconnect(ws, c, p); break;
      case 'seat_action': doSeatAction(ws, c, p); break;
      case 'chat': doChat(ws, c, p); break;
      case 'leave': doLeave(ws, c); break;
      default: sendErr(ws, 'unknown message type');
    }
  }

  function broadcast(roomId: string, msg: ServerMsg, seatId?: string): number {
    let delivered = 0;
    for (const [ws, c] of conns) {
      if (ws.readyState !== WebSocket.OPEN || c.roomId !== roomId) continue;
      if (seatId !== undefined && c.seatId !== seatId) continue;
      if (msg.type === 'phase_event' && msg.event) {
        if (msg.event.visibleTo !== null && !(c.seatId !== null && msg.event.visibleTo.includes(c.seatId))) continue;
        send(ws, msg);
      } else if (msg.type === 'lobby_update' && msg.room) {
        send(ws, { ...msg, room: { ...msg.room, log: msg.room.log.filter((e) => canSee(c.seatId, e)) } });
      } else {
        send(ws, msg);
      }
      delivered++;
    }
    if (msg.type === 'phase_event' && msg.event && delivered > 0) opts.onEvent(roomId, msg.event);
    return delivered;
  }

  server.on('connection', (ws) => {
    const c: Conn = { roomId: null, seatId: null, token: null };
    conns.set(ws, c);
    ws.on('message', (data) => handleMessage(ws, c, data));
    ws.on('error', () => { /* the close handler releases the seat */ });
    ws.on('close', () => {
      conns.delete(ws);
      releaseClaim(c, ws);
    });
  });

  return {
    server,
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of conns.keys()) {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        }
        conns.clear();
        server.close(() => resolve());
      }),
  };
}

/** Wire the noServer ws server into an HTTP server's upgrade events. */
export function attachHttp(handle: WsServerHandle, httpServer: http.Server): void {
  httpServer.on('upgrade', (req, socket, head) => {
    handle.server.handleUpgrade(req, socket, head, (ws) => {
      handle.server.emit('connection', ws, head);
    });
  });
}
