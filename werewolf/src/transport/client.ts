/**
 * WerewolfClient - client SDK for the game host (plan task 10).
 *
 * Used by the CLI entrypoint and (via the browser build) by the UI. Joins a
 * room, receives lobby/phase events, sends seat actions, and stores the
 * server-issued reconnection token. On an unexpected socket close the client
 * auto-reconnects with exponential backoff and re-syncs through reconnect().
 */
import { WebSocket } from 'ws';
import type { AgentAction } from '../engine/types';
import type { ClientMsg, ServerMsg } from './protocol';

type Listener = (data: unknown) => void;

export interface WerewolfClientOptions {
  /** Test hook: create the underlying socket instead of `new WebSocket(url)`. */
  socketFactory?: (url: string) => WebSocket;
}

interface Pending {
  want: (m: ServerMsg) => boolean;
  resolve: (v: ServerMsg) => void;
  reject: (e: Error) => void;
}

export class WerewolfClient {
  private readonly url: string;
  private readonly opts: WerewolfClientOptions;
  private sock: WebSocket | null = null;
  private tokenValue: string | null = null;
  private boundRoomId: string | null = null;
  private boundSeatId: string | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pending: Pending[] = [];
  private closedByUser = false;
  private backoffMs = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;

  constructor(url: string, opts: WerewolfClientOptions = {}) {
    this.url = url;
    this.opts = opts;
  }

  /** Reconnection token issued by the server on join (null before joining). */
  get token(): string | null {
    return this.tokenValue;
  }

  /** The seat this client is bound to (null before joining). */
  get seatId(): string | null {
    return this.boundSeatId;
  }

  /** Open (or reuse) the underlying socket. Resolves once the socket is open. */
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.sock && (this.sock.readyState === WebSocket.OPEN || this.sock.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    this.closedByUser = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const sock = this.opts.socketFactory ? this.opts.socketFactory(this.url) : new WebSocket(this.url);
      this.sock = sock;
      sock.on('open', () => {
        settled = true;
        this.backoffMs = 250;
        this.connecting = null;
        resolve();
      });
      sock.on('message', (data) => this.onMessage(data));
      sock.on('close', () => this.onSocketClose());
      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          this.connecting = null;
          reject(new Error('connect failed: ' + (err instanceof Error ? err.message : String(err))));
        }
      });
    });
    return this.connecting;
  }

  /**
   * Join a room. Resolves with the assigned seatId. An explicit seatId must
   * be a free human seat; otherwise the first free human seat is assigned.
   */
  async join(roomId: string, name: string, seatId?: string): Promise<string> {
    await this.connect();
    this.boundRoomId = roomId;
    const payload: Record<string, unknown> = { roomId, name };
    if (seatId !== undefined) payload.seatId = seatId;
    const ack = await this.request(
      (m) => m.type === 'lobby_update' && m.seatId !== undefined,
      () => this.post({ type: 'join', payload }),
      'join acknowledgement',
    );
    this.boundSeatId = ack.seatId ?? null;
    this.tokenValue = ack.token ?? this.tokenValue;
    if (this.boundSeatId === null) throw new Error('server did not assign a seat');
    return this.boundSeatId;
  }

  /**
   * Send a seat action (structured AgentAction or a plain speech string).
   * The server answers rejections with an 'error' message (see on('error'));
   * success is confirmed by the write completing.
   */
  async send(action: AgentAction | string): Promise<void> {
    if (this.boundSeatId === null) throw new Error('not joined to a room; call join() first');
    await this.connect();
    this.post({ type: 'seat_action', payload: { seatId: this.boundSeatId, action } });
  }

  /**
   * Re-establish the session after a disconnect. Uses the stored token when
   * none is given; resolves once the re-synced lobby_update has arrived.
   */
  async reconnect(token?: string): Promise<void> {
    const tk = token ?? this.tokenValue;
    if (!tk) throw new Error('no reconnection token; call join() first');
    await this.connect();
    await this.request(
      (m) => m.type === 'lobby_update',
      () => this.post({ type: 'reconnect', payload: { token: tk } }),
      'reconnect re-sync',
    );
    this.tokenValue = tk;
  }

  /** Subscribe to server messages by type. Returns an unsubscribe function. */
  on(event: string, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Close the socket permanently (no auto-reconnect). */
  close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (!sock) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (sock.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      sock.once('close', () => resolve());
      sock.close();
    });
  }

  private post(msg: ClientMsg): void {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) throw new Error('socket not open');
    this.sock.send(JSON.stringify(msg));
  }

  private request(want: (m: ServerMsg) => boolean, post: () => void, label: string, timeoutMs = 10000): Promise<ServerMsg> {
    return new Promise<ServerMsg>((resolve, reject) => {
      let entry: Pending = {
        want,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      const t = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error('timed out waiting for ' + label));
      }, timeoutMs);
      this.pending.push(entry);
      try {
        post();
      } catch (err) {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(data: unknown): void {
    let m: ServerMsg;
    try {
      m = JSON.parse(String(data)) as ServerMsg;
    } catch {
      return;
    }
    if (m.type === 'lobby_update' && typeof m.token === 'string') this.tokenValue = m.token;
    // A pending request and registered listeners both observe the message:
    // requests resolve on it, listeners are additionally notified.
    const idx = this.pending.findIndex((p) => p.want(m));
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      if (m.type === 'error') p.reject(new Error(m.message ?? 'server error'));
      else p.resolve(m);
    }
    const set = this.listeners.get(m.type);
    if (set) for (const cb of [...set]) cb(m);
  }

  private onSocketClose(): void {
    this.sock = null;
    this.connecting = null;
    if (this.closedByUser) return;
    if (this.tokenValue === null && this.boundRoomId === null) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect()
        .then(() => this.reconnect(this.tokenValue ?? undefined))
        .catch(() => this.onSocketClose());
    }, delay);
  }
}
