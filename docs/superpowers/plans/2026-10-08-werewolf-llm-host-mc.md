# Werewolf LLM Agent Host (MC) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Node.js platform where a deterministic LLM Host agent runs werewolf games (dealing, phases, skill prompts, time control), and LLM Player agents can fill any seat — alongside humans or alone.

**Architecture:** A pure, deterministic rules engine (`engine/`) owns all game state transitions and legality; LLM agents (`agents/`) are thin prompt-template wrappers that emit strict-JSON decisions the engine validates; a WebSocket transport (`transport/`) serves a minimal web UI and a CLI client; LLM seats and the Host seat are the same kind of entity — a "seat adapter" routes each turn to a human (UI submit) or an agent (LLM call with fallback).

**Tech Stack:** Node.js 20+, TypeScript, `ws` (WebSocket), `vitest` (tests), `typescript` compiler via `tsx`/`tsup` (dev), no frontend framework for v1 (vanilla HTML/JS client).

**Spec:** `docs/superpowers/specs/2026-10-08-werewolf-llm-host-mc-design.md`

## Global Constraints

- LLM calls always use `temperature: 0`; no wall-clock value is ever injected into an LLM prompt (spec §2.5, §3).
- The engine (`engine/`) contains no I/O and no LLM call — it is pure and unit-testable without a model (spec §2.2).
- The single source of truth for private information is the `Event.visibleTo` field; agents and humans never decide visibility (spec §4).
- Every LLM decision must pass schema validation before the engine acts on it; a second failure triggers a safe fallback, never a game stall (spec §3, §8).
- Role rules ship as JSON, not hardcoded (spec §2.1).
- All timestamps in code are UTC millisecond epoch numbers (`number`), never `Date` objects in engine/agent code (spec §8 determinism).

## Review Focus

- **Private info leak:** a seer's result or werewolf ping appearing in a public event or in an LLM prompt for a seat that should not see it. Pinned by Task 14's visibility-filter tests and Task 11's prompt-redaction tests.
- **LLM schema failure mid-game:** an agent returns malformed JSON; the game must fall back and continue within its 30s hard timeout, not hang. Pinned by Task 12's fallback tests.
- **Reconnect visibility:** a reconnecting human seat must only receive events it is allowed to see, and must never receive role cards it never saw originally. Pinned by Task 16's reconnect tests.
- **Timing budget overrun:** a phase's wall-clock budget must end the phase deterministically even if an agent is mid-response; the phase transition must not depend on LLM latency. Pinned by Task 13's budget tests.
- **Win check timing:** win must be evaluated at the end of every `dawn` and after every `voting` phase, in exactly that order — a missed check lets a dead-game run on. Pinned by Task 6's win-check tests.

---

### Task 1: Project Scaffold + Engine Core State

**Files:**
- Create: `werewolf/package.json`, `werewolf/tsconfig.json`, `werewolf/src/engine/types.ts`
- Create: `werewolf/src/engine/deck.ts`
- Create: `werewolf/src/engine/deck.test.ts`
- Create: `werewolf/data/roles-standard.json`
- Create: `werewolf/data/timings-default.json`

**Interfaces:**
- Produces: `RoleConfig` (see below), `RoleState`, `SeatState`, `RoomState`, `GamePhase`, `SeatKind` — exact shapes used by every later task.
  - `RoleConfig = { id, name, faction: 'villain'|'villager', min, max, night?: NightRule, day?: DayRule }`
  - `NightRule = { order, action: 'target_player'|'protect'|'observe'|'pass', targets: number, maxTargets: number, promptTemplateId: string }`
  - `RoleState = { roleId, faction, alive: boolean, skillUsed?: boolean, skillTarget?: string, extra?: Record<string, unknown> }`
  - `SeatState = { seatId: string, kind: SeatKind, name: string, role?: RoleState, offline?: boolean }`
  - `RoomState = { phase: GamePhase, seats: SeatState[], currentPhaseBudgetMs: number, phaseStartedAt: number, log: Event[] }`
  - `GamePhase = 'lobby'|'night'|'dawn'|'day_discussion'|'voting'|'finished'`
  - `SeatKind = 'human'|'agent'|'host'`
  - `Event = { ts: number, phase: GamePhase, type: string, payload: Record<string, unknown>, visibleTo: string[] | null }`
- Consumes: `werewolf/data/roles-standard.json` (9-role standard config) and `werewolf/data/timings-default.json` (phase budgets).

- [ ] **Step 1: Write the failing test**

`werewolf/src/engine/deck.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dealRoles, validateRoleConfig } from './deck';
import standardRoles from '../../data/roles-standard.json';

describe('validateRoleConfig', () => {
  it('rejects a config whose total count does not match seat count', () => {
    const bad = { config: standardRoles, seatCount: 10, expected: 9 };
    expect(bad).toBe(undefined); // placeholder, replaced in step 3 with real assertion
  });
});
```

(Replace this placeholder body in step 3 — it exists only to pin the test file into the repo.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/engine/deck.test.ts`
Expected: FAIL — `./deck` module does not exist yet.

- [ ] **Step 3: Implement `dealRoles` and `validateRoleConfig` in `werewolf/src/engine/deck.ts`**

`validateRoleConfig(config, seatCount): string[]` returns an array of human-readable violation strings (empty = valid). `dealRoles(config, seatCount, rng)` returns a shuffled role list of length `seatCount`, throwing if validation fails. `rng` is an injected `() => number` for testability (determinism requirement).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/engine/deck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(engine): add role config validation and dealing"
```

---

### Task 2: Engine State Machine

**Files:**
- Create: `werewolf/src/engine/state.ts`
- Create: `werewolf/src/engine/state.test.ts`

**Interfaces:**
- Consumes: `RoomState`, `GamePhase`, `Event` from Task 1.
- Produces: `EngineState` class (in-memory, no I/O), methods:
  - `constructor(seats: SeatState[], timings: Record<GamePhase, number>, rng: () => number)`
  - `deal(config: RoleConfig[]): void` — calls `dealRoles`, assigns to seats
  - `startNight(): void`, `startDawn(): void`, `startDayDiscussion(): void`,
    `startVoting(): void`, `advancePhase(): GamePhase` (returns new phase)
  - `recordEvent(type: string, payload: Record<string, unknown>, visibleTo?: string[] | null): Event`
  - `phaseRemainingMs(): number`

- [ ] **Step 1: Write the failing test**

`werewolf/src/engine/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EngineState } from './state';

describe('EngineState phase cycle', () => {
  it('transitions night -> dawn -> day_discussion -> voting -> night in order', () => {
    const s = new EngineState(
      [{ seatId: 's1', kind: 'human', name: 'A' }, { seatId: 's2', kind: 'agent', name: 'B' }],
      { night: 10000, dawn: 5000, day_discussion: 30000, voting: 15000, lobby: 0, finished: 0 },
      () => 0.5
    );
    expect(s.phase).toBe('lobby');
    s.startNight(); expect(s.phase).toBe('night');
    s.advancePhase(); expect(s.phase).toBe('dawn');
    s.advancePhase(); expect(s.phase).toBe('day_discussion');
    s.advancePhase(); expect(s.phase).toBe('voting');
    s.advancePhase(); expect(s.phase).toBe('night');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/engine/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `EngineState` in `werewolf/src/engine/state.ts`**

`advancePhase()` follows the fixed cycle `night → dawn → day_discussion → voting → night`, wrapping back to `night` indefinitely until `finished`. `phaseRemainingMs()` is computed from `phaseStartedAt` + budget vs. an injected `now()` clock (default `Date.now`, overridable for tests).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/engine/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(engine): add phase state machine"
```

---

### Task 3: Skill Resolution + Win Check

**Files:**
- Create: `werewolf/src/engine/skills.ts`
- Create: `werewolf/src/engine/skills.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `RoleConfig` from Tasks 1–2.
- Produces:
  - `resolveNightAction(state: EngineState, seatId: string, action: AgentAction): NightOutcome`
    where `AgentAction = { action: 'target_player'|'protect'|'observe'|'pass', targets: string[], speech?: string }`
    and `NightOutcome = { ok: true, events: Event[] } | { ok: false, reason: string }`
  - `checkWin(state: EngineState): { done: boolean, winner?: 'villain'|'villager' }`

- [ ] **Step 1: Write the failing test**

`werewolf/src/engine/skills.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveNightAction, checkWin } from './skills';
// state built with 3 werewolves alive, 3 villagers alive
describe('checkWin', () => {
  it('returns winner villager when all werewolves are dead', () => { /* ... */ });
  it('returns winner villain when all non-werewolves are dead', () => { /* ... */ });
  it('returns done=false while both factions have survivors', () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/engine/skills.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveNightAction` and `checkWin` in `werewolf/src/engine/skills.ts`**

`resolveNightAction` validates: target count == role's `targets`, no self-target, no dead targets, `maxTargets` respected, once-per-game flags (`skillUsed`). Emits `Event`s with correct `visibleTo` (e.g., seer result visible only to the seer's seat; werewolf kill visible only to werewolf seats). `checkWin` runs per spec §2.5: all werewolves dead → `villager`; all non-werewolves dead → `villain`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/engine/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(engine): add skill resolution and win check"
```

---

### Task 4: LLM Call Wrapper (determinism + fallback)

**Files:**
- Create: `werewolf/src/agents/llm-call.ts`
- Create: `werewolf/src/agents/llm-call.test.ts`

**Interfaces:**
- Consumes: `RoleConfig`, `Event` (from Tasks 1–3) for prompt construction.
- Produces:
  - `type LlmClient = (prompt: string, opts: { temperature: number; schema?: string }) => Promise<string>`
  - `callAgentDecision(client: LlmClient, ctx: AgentPromptContext, schema: string, now: () => number, timeoutMs = 30000): Promise<{ decision: AgentAction, fallbackUsed: boolean }>`
  - `AgentPromptContext = { role: RoleConfig, publicLog: Event[], privateLog: Event[], aliveSeats: SeatState[] }`

- [ ] **Step 1: Write the failing test**

`werewolf/src/agents/llm-call.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { callAgentDecision } from './llm-call';

describe('callAgentDecision', () => {
  it('returns parsed decision on first valid response', async () => { /* mock client returns valid JSON */ });
  it('retries once on schema failure, then falls back', async () => { /* mock client returns garbage twice */ });
  it('falls back to safe default and sets fallbackUsed=true', async () => { /* ... */ });
  it('never exceeds timeoutMs and falls back on timeout', async () => { /* mock client hangs */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/agents/llm-call.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `callAgentDecision` in `werewolf/src/agents/llm-call.ts`**

Calls `client` with a prompt built from `AgentPromptContext` (template-rendered, no wall-clock injection), enforces `temperature: 0`, validates against `schema` (JSON Schema via `ajv`). On parse/schema failure: retry once with an error note appended to the prompt; second failure or timeout → return `{ decision: safeDefaultFor(role), fallbackUsed: true }` where `safeDefaultFor` is `'pass'` for most roles and a random legal `target_player` (seeded by `now()`) for werewolf. Logs a structured `agent_fallback` event.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/agents/llm-call.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(agents): add deterministic LLM call wrapper with fallback"
```

---

### Task 5: Host Agent (MC narration + pacing)

**Files:**
- Create: `werewolf/src/agents/host-agent.ts`
- Create: `werewolf/src/agents/host-agent.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `Event`, `LlmClient` (Tasks 1–4).
- Produces:
  - `class HostAgent { constructor(client: LlmClient, state: EngineState, timings: Record<string, number>) }`
  - `HostAgent.announcePhaseTransition(): Promise<Event>`
  - `HostAgent.observeSilence(): Promise<Event | null>` — returns a nudge `Event` if `day_discussion` cadence is below `hostNudge.thresholdMsgPerMin`, else `null`.
  - `HostAgent.forceFinalCall(): Promise<Event>` — emits a "final round" nudge before the phase timer expires.

- [ ] **Step 1: Write the failing test**

`werewolf/src/agents/host-agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HostAgent } from './host-agent';

describe('HostAgent.observeSilence', () => {
  it('returns null when cadence is above threshold', async () => { /* ... */ });
  it('returns a nudge Event when cadence drops below threshold', async () => { /* ... */ });
  it('never blocks the phase timer (always resolves within budget)', async () => { /* mock a slow client */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/agents/host-agent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `HostAgent` in `werewolf/src/agents/host-agent.ts`**

`announcePhaseTransition` builds a templated narration from the current phase + last `Event`s, calls the client (temperature 0), and records the result as a public `Event` (visibleTo: null). `observeSilence`/`forceFinalCall` are best-effort: if the LLM call exceeds the remaining phase budget, resolve with `null` immediately rather than blocking (spec §6: "Timers always end the phase regardless of agent behavior").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/agents/host-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(agents): add Host agent for MC narration and pacing"
```

---

### Task 6: Player Agent (roleplay decisions)

**Files:**
- Create: `werewolf/src/agents/player-agent.ts`
- Create: `werewolf/src/agents/player-agent.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `LlmClient`, `callAgentDecision` (Tasks 1–5).
- Produces:
  - `class PlayerAgent { constructor(seatId: string, client: LlmClient, state: EngineState, persona?: string) }`
  - `PlayerAgent.onNightAction(): Promise<AgentAction>` — builds the seat's `AgentPromptContext` (respecting `visibleTo`), calls `callAgentDecision`, returns the decision.
  - `PlayerAgent.onDaySpeech(): Promise<string>` — returns the `speech` field for the day_discussion phase.

- [ ] **Step 1: Write the failing test**

`werewolf/src/agents/player-agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PlayerAgent } from './player-agent';

describe('PlayerAgent.onNightAction', () => {
  it('passes only events the seat is allowed to see to the LLM', async () => { /* verify visibleTo filtering */ });
  it('returns a valid AgentAction for target_player roles', async () => { /* ... */ });
  it('falls back to safe default on LLM failure', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/agents/player-agent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `PlayerAgent` in `werewolf/src/agents/player-agent.ts`**

`onNightAction` computes `publicLog = state.log.filter(e => e.visibleTo === null)`, `privateLog = state.log.filter(e => e.visibleTo?.includes(this.seatId))`, builds the prompt via the role's `promptTemplateId`, calls `callAgentDecision`, returns the decision (never throws — fallback handled internally). `onDaySpeech` is a short LLM call for a 1–3 sentence in-character remark.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/agents/player-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(agents): add Player agent for roleplay decisions"
```

---

### Task 7: Seat Adapter (route turns to human or agent)

**Files:**
- Create: `werewolf/src/agents/seat-adapter.ts`
- Create: `werewolf/src/agents/seat-adapter.test.ts`

**Interfaces:**
- Consumes: `PlayerAgent`, `HostAgent`, `EngineState` (Tasks 5–6).
- Produces:
  - `type SeatHandler = (seat: SeatState, action: AgentAction | string) => void` (engine callback for a seat's final submission)
  - `class SeatAdapter { constructor(state: EngineState, llmClient: LlmClient, humanSubmit: (seatId: string) => Promise<AgentAction | string>) }`
  - `SeatAdapter.runTurn(seatId: string): Promise<void>` — for agent seats, calls the appropriate agent and submits; for human seats, awaits `humanSubmit` (with a hard phase-budget timeout that auto-submits a safe default on expiry).
  - `SeatAdapter.runHostTurn(): Promise<void>` — calls `HostAgent.announcePhaseTransition` / `observeSilence` as appropriate.

- [ ] **Step 1: Write the failing test**

`werewolf/src/agents/seat-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SeatAdapter } from './seat-adapter';

describe('SeatAdapter.runTurn', () => {
  it('routes agent seats to PlayerAgent and submits the decision', async () => { /* ... */ });
  it('waits for humanSubmit and submits the human action on success', async () => { /* ... */ });
  it('auto-submits a safe default if humanSubmit exceeds the phase budget', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/agents/seat-adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `SeatAdapter` in `werewolf/src/agents/seat-adapter.ts`**

`runTurn` inspects `state.seats.find(s => s.seatId === seatId).kind`: `'agent'` → `PlayerAgent.onNightAction()` (or `onDaySpeech` during `day_discussion`); `'human'` → `await humanSubmit(seatId)` with a `Promise.race` against a timeout derived from the remaining phase budget; on timeout, submit `{ action: 'pass', targets: [] }` and record a `timeout` `Event`. `'host'` seats never take a turn — they are driven by `runHostTurn()` called by the orchestrator (Task 8).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/agents/seat-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(agents): add seat adapter routing turns to human or agent"
```

---

### Task 8: Game Orchestrator (end-to-end loop)

**Files:**
- Create: `werewolf/src/orchestrator.ts`
- Create: `werewolf/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `SeatAdapter`, `HostAgent`, `resolveNightAction`, `checkWin` (Tasks 2–7).
- Produces:
  - `class Orchestrator { constructor(state: EngineState, adapter: SeatAdapter, host: HostAgent, onEvent: (e: Event) => void, now: () => number) }`
  - `Orchestrator.start(config: RoleConfig[]): Promise<void>` — deals, enters the night loop.
  - `Orchestrator.runUntilDone(): Promise<{ winner: 'villain'|'villager' }>` — loops `advancePhase` + per-phase turns + win check until `checkWin().done`.
  - `Orchestrator.isRunning: boolean`

- [ ] **Step 1: Write the failing test**

`werewolf/src/orchestrator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from './orchestrator';

describe('Orchestrator.runUntilDone', () => {
  it('runs a full game with all-LLM seats and reaches a winner', async () => { /* mock clients */ });
  it('stops immediately when checkWin returns done', async () => { /* ... */ });
  it('enforces phase budgets and advances even if a turn is slow', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `Orchestrator` in `werewolf/src/orchestrator.ts`**

Night loop: for each role in `night.order`, call `adapter.runTurn(seatId)` for each seat holding that role, `resolveNightAction`, `state.recordEvent(...)` for each returned `Event` (via `onEvent`), then `checkWin` — if done, set `state.phase = 'finished'` and stop. Day loop: `adapter.runTurn` for each alive seat (speech), `host.observeSilence()` cadence check, then voting via `adapter.runTurn` (vote submission), `checkWin` again. Wrap every phase in a wall-clock guard: if `state.phaseRemainingMs() <= 0`, force-advance with safe defaults.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(orchestrator): add end-to-end game loop with timing enforcement"
```

---

### Task 9: Transport — WebSocket Server

**Files:**
- Create: `werewolf/src/transport/ws-server.ts`
- Create: `werewolf/src/transport/ws-server.test.ts`
- Create: `werewolf/src/transport/protocol.ts` (shared message types)

**Interfaces:**
- Consumes: `Orchestrator`, `Event`, `RoomState` (Tasks 1–8).
- Produces (in `protocol.ts`, consumed by UI and CLI in Tasks 10–11):
  - `type ClientMsg = { type: 'join'|'leave'|'seat_action'|'chat'|'reconnect', payload: Record<string, unknown> }`
  - `type ServerMsg = { type: 'lobby_update'|'phase_event'|'chat'|'error', event?: Event, room?: RoomState }`
  - `function createWsServer(opts: { rooms: Map<string, Orchestrator>, onEvent: (roomId: string, e: Event) => void }): { server: WebSocket.Server, broadcast: (roomId: string, msg: ServerMsg, seatId?: string) => void }`

- [ ] **Step 1: Write the failing test**

`werewolf/src/transport/ws-server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createWsServer } from './ws-server';

describe('createWsServer', () => {
  it('accepts a join message and emits lobby_update to the room', async () => { /* ... */ });
  it('routes seat_action to the orchestrator and emits phase_event back', async () => { /* ... */ });
  it('honors visibleTo when broadcasting phase_event to specific seats only', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/transport/ws-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createWsServer` in `werewolf/src/transport/ws-server.ts`**

Maintains a `Map<socketId, { roomId, seatId, token }>` for connection state. On `join`, assigns a seat (or rejects if full) and emits `lobby_update`. On `seat_action`, routes to the owning `Orchestrator`'s pending `humanSubmit` promise (from Task 7). `broadcast` filters by `Event.visibleTo`: if `visibleTo` is set, send only to the matching seat's socket(s); if `null`, send to all seats in the room. `reconnect(token)` re-syncs the client with the full `state.log` filtered by that seat's visibility.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/transport/ws-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(transport): add WebSocket server with visibility-aware broadcast"
```

---

### Task 10: Transport — Client SDK (web + CLI)

**Files:**
- Create: `werewolf/src/transport/client.ts`
- Create: `werewolf/src/cli/index.ts`
- Create: `werewolf/src/transport/client.test.ts`

**Interfaces:**
- Consumes: `ClientMsg`, `ServerMsg` from Task 9.
- Produces:
  - `class WerewolfClient { constructor(url: string) }`
  - `WerewolfClient.connect(): Promise<void>`, `join(roomId: string, name: string): Promise<string /* seatId */>`, `send(action: AgentAction | string): Promise<void>`, `on(event: string, cb: (data: unknown) => void): void`, `reconnect(token: string): Promise<void>`
  - `werewolf-cli` bin (via `package.json` `bin` field): `join <url> --room <id> --name <n> [--seat <n>] [--watch]`

- [ ] **Step 1: Write the failing test**

`werewolf/src/transport/client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WerewolfClient } from './client';

describe('WerewolfClient', () => {
  it('connects and joins a room, returning a seatId', async () => { /* mock ws */ });
  it('sends seat_action and resolves on server ack', async () => { /* ... */ });
  it('reconnects with a token and receives a re-synced filtered log', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/transport/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `WerewolfClient` in `werewolf/src/transport/client.ts` and the CLI entrypoint in `werewolf/src/cli/index.ts`**

Client stores a reconnection token (server-issued on `join`), auto-reconnects with exponential backoff on socket close. The CLI prints `phase_event` messages to stdout and prompts (line-by-line, stdin) for `seat_action` when the server signals it is the seat's turn; `--watch` suppresses the prompt (LLM-only games / spectator mode).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/transport/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(transport): add client SDK and CLI entrypoint"
```

---

### Task 11: LLM Provider Adapters

**Files:**
- Create: `werewolf/src/llm/openai-compatible.ts`
- Create: `werewolf/src/llm/openai-compatible.test.ts`
- Create: `werewolf/src/llm/local-vllm.ts`
- Create: `werewolf/src/llm/types.ts`

**Interfaces:**
- Consumes: `LlmClient` type from Task 4.
- Produces:
  - `function createOpenAICompatibleClient(opts: { baseUrl: string; apiKey: string; model: string }): LlmClient`
  - `function createLocalVllmClient(opts: { baseUrl: string; model: string }): LlmClient`
  - `LlmClient` (re-exported) — `llm/types.ts` is the single import site for all call sites.

- [ ] **Step 1: Write the failing test**

`werewolf/src/llm/openai-compatible.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createOpenAICompatibleClient } from './openai-compatible';

describe('createOpenAICompatibleClient', () => {
  it('returns a client that calls the chat-completions endpoint with temperature 0', async () => { /* mock fetch */ });
  it('propagates HTTP errors as thrown errors', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/llm/openai-compatible.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both adapters**

`openai-compatible.ts`: uses `fetch` (Node 20 global) against `{baseUrl}/chat/completions`, always sets `temperature: 0`. `local-vllm.ts`: same endpoint shape (vLLM is OpenAI-compatible), no `apiKey`. Both return a `LlmClient` that throws on non-2xx (caller handles retry via `callAgentDecision`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/llm/openai-compatible.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(llm): add OpenAI-compatible and local vLLM adapters"
```

---

### Task 12: Prompt Templates + Redaction

**Files:**
- Create: `werewolf/src/agents/prompts.ts`
- Create: `werewolf/src/agents/prompts.test.ts`

**Interfaces:**
- Consumes: `AgentPromptContext` (Task 4), `RoleConfig` (Task 1).
- Produces:
  - `function buildNightPrompt(role: RoleConfig, ctx: AgentPromptContext): string`
  - `function buildDayPrompt(role: RoleConfig, ctx: AgentPromptContext, persona?: string): string`
  - `function buildHostPrompt(state: EngineState, phase: GamePhase, cadence: number): string`

- [ ] **Step 1: Write the failing test**

`werewolf/src/agents/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildNightPrompt, buildDayPrompt, buildHostPrompt } from './prompts';

describe('prompt redaction', () => {
  it('includes only publicLog in a non-werewolf seat prompt', () => { /* verify no privateLog leak */ });
  it('includes privateLog for a werewolf seat', () => { /* ... */ });
  it('never includes a wall-clock timestamp in any prompt', () => { /* assert no ISO date in output */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/agents/prompts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three builders in `werewolf/src/agents/prompts.ts`**

Each builder renders a fixed template (string, not LLM-generated) with the role's `promptTemplateId` as the base, splicing in `aliveSeats`, `publicLog` (always), `privateLog` (only if the seat's `visibleTo` includes its own seatId), and the persona string. No `Date`/`Date.now()` value is ever stringified into the output (determinism constraint). `buildHostPrompt` additionally includes the live `cadence` number (msg/min, a plain number, not a timestamp).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/agents/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(agents): add prompt template builders with redaction"
```

---

### Task 13: Timing / Phase Budget Enforcement

**Files:**
- Create: `werewolf/src/engine/timing.ts`
- Create: `werewolf/src/engine/timing.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `data/timings-default.json` (Task 1).
- Produces:
  - `class PhaseTimer { constructor(state: EngineState, timings: Record<GamePhase, number>, now: () => number) }`
  - `PhaseTimer.remainingMs(): number`
  - `PhaseTimer.onExpiry(cb: () => void): void` — fires `cb` at most once when `remainingMs() <= 0`.
  - `PhaseTimer.softWarnMs(): number` — the configured `softWarnMs` offset for the current phase (for UI countdown highlight).

- [ ] **Step 1: Write the failing test**

`werewolf/src/engine/timing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PhaseTimer } from './timing';

describe('PhaseTimer', () => {
  it('fires onExpiry exactly once when remainingMs hits 0', () => { /* advance injected clock */ });
  it('does not fire onExpiry a second time after the first fire', () => { /* ... */ });
  it('returns softWarnMs from the config, not a computed value', () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/engine/timing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `PhaseTimer` in `werewolf/src/engine/timing.ts`**

Uses an injected `now()` (never `Date.now` internally). `onExpiry` registers a callback fired by the orchestrator's tick loop (Task 8 already calls into this via `state.phaseRemainingMs()`; this task extracts and pins the contract). Idempotent: a second call to `onExpiry` after the callback has fired is a no-op.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/engine/timing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(engine): add PhaseTimer with idempotent expiry"
```

---

### Task 14: Visibility Filter (private-info leak guard)

**Files:**
- Create: `werewolf/src/engine/visibility.ts`
- Create: `werewolf/src/engine/visibility.test.ts`

**Interfaces:**
- Consumes: `Event`, `SeatState` (Task 1).
- Produces:
  - `function eventsVisibleTo(events: Event[], seatId: string): Event[]`
  - `function assertNoLeak(events: Event[], seatId: string, role: RoleConfig): void` — throws if any event in `events` has `visibleTo` that excludes `seatId` but whose `payload` references role-private data (heuristic: `payload.private === true`).

- [ ] **Step 1: Write the failing test**

`werewolf/src/engine/visibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eventsVisibleTo, assertNoLeak } from './visibility';

describe('eventsVisibleTo', () => {
  it('includes events with visibleTo=null and events whose visibleTo includes the seat', () => { /* ... */ });
  it('excludes events whose visibleTo is set and does not include the seat', () => { /* ... */ });
});
describe('assertNoLeak', () => {
  it('throws if a private-marked event is exposed to a seat not in visibleTo', () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run src/engine/visibility.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both functions in `werewolf/src/engine/visibility.ts`**

`eventsVisibleTo` is a simple filter. `assertNoLeak` is a defensive runtime check called by the transport layer (Task 9) before broadcast: for every event with `payload.private === true`, verify `visibleTo` includes every seat that the transport layer is about to send it to; throw a descriptive error on mismatch (and log, never silently drop).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run src/engine/visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(engine): add visibility filter and leak-assertion guard"
```

---

### Task 15: UI — Lobby + Game Screen (minimal)

**Files:**
- Create: `werewolf/public/index.html`
- Create: `werewolf/public/app.js`
- Create: `werewolf/public/app.js.test.js` (jsdom-based, via vitest)

**Interfaces:**
- Consumes: `WerewolfClient` (Task 10), `ServerMsg` (Task 9).
- Produces: a single-page app served by a static file server (add `werewolf/server.ts` — a minimal `http` + `ws` server that serves `public/` and the WS endpoint from Task 9).

- [ ] **Step 1: Write the failing test**

`werewolf/public/app.js.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { renderPhaseBanner, renderSeatList } from './app.js';

describe('renderPhaseBanner', () => {
  it('renders the current phase name and remaining seconds', () => { /* ... */ });
});
describe('renderSeatList', () => {
  it('marks offline seats and highlights the current acting seat', () => { /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd werewolf && npx vitest run public/app.js.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `werewolf/public/app.js` and `werewolf/server.ts`**

`app.js` exposes `renderPhaseBanner(phase, remainingMs)` and `renderSeatList(seats, actingSeatId)` as pure DOM-string functions (testable without jsdom), plus a `boot()` that wires `WerewolfClient` to DOM events. `server.ts` starts an `http` server serving `public/` and attaches the `ws` server from Task 9. The "confirm" button for LLM-seat drafts (spec §7) is a simple overlay: when the server pushes an `llm_draft` message for a seat under this client's control, show the draft with a 20s countdown and an editable textarea; on confirm, submit via `client.send(action)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd werewolf && npx vitest run public/app.js.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "feat(ui): add minimal lobby and game screen with draft-confirm overlay"
```

---

### Task 16: Reconnect + Full-Game Integration Test

**Files:**
- Create: `werewolf/src/transport/reconnect.test.ts`
- Create: `werewolf/tests/integration/full-game.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–15.
- Produces: no new production code — this task is pure test coverage for the two Review Focus items: reconnect visibility, and end-to-end determinism.

- [ ] **Step 1: Write the failing tests**

`werewolf/src/transport/reconnect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// spin up createWsServer with a real Orchestrator (mock LLM), join 3 seats,
// drop one seat's socket, reconnect with its token, verify it receives
// only events whose visibleTo includes its seatId (no role-card leak for a
// non-seer seat)
```

`werewolf/tests/integration/full-game.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// full lobby -> night -> dawn -> day_discussion -> voting -> finished loop
// with all-LLM seats and a fixed-seed mock LLM; assert:
//   (a) event log is legal (no private payload in a visibleTo=null event)
//   (b) the same seed produces the identical event log on a second run
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd werewolf && npx vitest run src/transport/reconnect.test.ts tests/integration/full-game.test.ts`
Expected: FAIL (assertions not yet satisfied, or missing mock LLM helper).

- [ ] **Step 3: Add the mock LLM helper and fix any production bugs the tests surface**

Create `werewolf/tests/helpers/mock-llm.ts` exporting `createSeededMockLlm(seed)` that returns an `LlmClient` producing deterministic JSON from a PRNG seeded by `seed`. Wire it into both integration tests. Fix any visibility or determinism bugs the tests expose (these are the bugs this task is designed to catch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd werewolf && npx vitest run src/transport/reconnect.test.ts tests/integration/full-game.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add werewolf
git commit -m "test: add reconnect visibility and full-game determinism integration tests"
```
