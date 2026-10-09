/**
 * Core shared types for the werewolf engine.
 *
 * Pure data — no I/O, no Date objects. All timestamps are UTC millisecond
 * epoch numbers (number) (spec §8 determinism constraint).
 */

export type Faction = 'villain' | 'villager';

export type GamePhase =
  | 'lobby'
  | 'night'
  | 'dawn'
  | 'day_discussion'
  | 'voting'
  | 'finished';

export type SeatKind = 'human' | 'agent' | 'host';

export type NightActionType = 'target_player' | 'protect' | 'observe' | 'pass';

/** Night-time skill rule for a role (spec §2.1 / §2.4). */
export interface NightRule {
  /** Execution order within the night phase (1 = acts first). */
  order: number;
  action: NightActionType;
  /** How many targets this action takes (v1: 1 for all acting roles). */
  targets: number;
  /** Hard cap on targets; engine validates submissions against it. */
  maxTargets: number;
  /** Identifies the per-role prompt template rendered by the Host agent. */
  promptTemplateId: string;
}

/** Day-phase rule for a role (v1: mostly informational; see spec §2.1). */
export interface DayRule {
  order?: number;
  action?: 'speak' | 'pass' | 'shoot_on_death';
  promptTemplateId?: string;
}

/**
 * A role definition. Rules are data, not code (spec §2.1): the engine loads
 * any role set from JSON.
 */
export interface RoleConfig {
  id: string;
  name: string;
  faction: Faction;
  min: number;
  max: number;
  night?: NightRule;
  day?: DayRule;
}

/** Per-seat role state stored by the engine (spec §2.1). */
export interface RoleState {
  roleId: string;
  faction: Faction;
  alive: boolean;
  /** True once a once-per-game skill (witch save, seer limit, ...) has been used. */
  skillUsed?: boolean;
  /** Seat id last targeted by this role's skill. */
  skillTarget?: string;
  /** Role-specific scratch space (e.g. isWerewolfLeader). */
  extra?: Record<string, unknown>;
}

/** A seat in a room: human, LLM agent, or host seat (spec §4). */
export interface SeatState {
  seatId: string;
  kind: SeatKind;
  name: string;
  role?: RoleState;
  offline?: boolean;
}

/**
 * A game event. `visibleTo` is the SINGLE mechanism for private information
 * (spec §4): null = public; an array = only those seats may see it.
 */
export interface Event {
  /** UTC ms epoch; never a Date. */
  ts: number;
  phase: GamePhase;
  type: string;
  payload: Record<string, unknown>;
  visibleTo: string[] | null;
}

/** Room snapshot used by the transport layer (spec §4). */
export interface RoomState {
  id: string;
  status: 'lobby' | 'playing' | 'finished';
  hostConfig: Record<string, unknown>;
  seats: SeatState[];
  log: Event[];
  startedAt: number;
  endedAt?: number;
}

/**
 * A strict-JSON decision an LLM agent emits (spec §3).
 * `speech` is what the agent says aloud to the room; the engine never
 * re-derives speech.
 */
export interface AgentAction {
  action: NightActionType;
  targets: string[];
  speech?: string;
  confidence?: number;
}

/** Result of engine-resolving a night action (plan task 3). */
export type NightOutcome =
  | { ok: true; events: Event[] }
  | { ok: false; reason: string };

/** LLM chat-completion client (the single import site is llm/types.ts). */
export type LlmClient = (
  prompt: string,
  opts: { temperature: number; schema?: string },
) => Promise<string>;

/** Everything a player agent may legally see when building a prompt (plan task 4). */
export interface AgentPromptContext {
  role: RoleConfig;
  /** Events with visibleTo === null. */
  publicLog: Event[];
  /** Events whose visibleTo includes this seat (already filtered — never trust a caller). */
  privateLog: Event[];
  aliveSeats: SeatState[];
  /** The acting seat's own id (for self-target checks in fallbacks). */
  selfSeatId: string;
  persona?: string;
}
