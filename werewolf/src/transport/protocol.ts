/**
 * Shared wire protocol between the host (ws server) and clients (UI / CLI).
 * Plan task 9; consumed by tasks 10-11.
 */
import type { Event, RoomState } from '../engine/types';

/** Messages client (UI / CLI) sends to the host. */
export type ClientMsg = {
  type: 'join' | 'leave' | 'seat_action' | 'chat' | 'reconnect';
  payload: Record<string, unknown>;
};

/** Messages host sends to clients. */
export type ServerMsg = {
  type: 'lobby_update' | 'phase_event' | 'chat' | 'error';
  /** Engine event (phase_event, chat). */
  event?: Event;
  /** Room snapshot (lobby_update); its log is filtered per recipient by visibility. */
  room?: RoomState;
  /** The seat assigned to this socket (join-confirmation lobby_update only). */
  seatId?: string;
  /** Reconnection token issued on join (join-confirmation lobby_update only). */
  token?: string;
  /** Human-readable reason (error messages, leave acknowledgement). */
  message?: string;
};
