# Werewolf LLM Agent Host (MC) — Design Spec

**Status:** v2, supersedes the v1 sketch of 2026-10-08.
**Goal:** A single Node.js platform where LLM agents can play alongside humans, or fill player seats alone, and a Host/MC LLM agent runs the whole werewolf game: dealing, phases, skill prompts, and time control. Humans join through the same platform, but every game action — including the LLM agent's — is executed deterministically by the engine.

## 1. Intent & Scope

- One codebase; no separate "agent" vs "host" service.
- Game rules are data, not code: a standard 9-role preset ships first, but the engine loads any role set from JSON.
- LLM agents are **deterministic**: same game state → same decision (LLM called with temperature 0; no LLM call for pure rules steps). A human can pause and edit an LLM's draft before it is submitted (see §7).
- Three modes in one system:
  - **Human + LLM players:** LLM fills seats for real humans.
  - **LLM vs LLM:** 1+ human watches; zero humans also allowed.
  - **LLM-only MC:** no LLM players; the Host agent runs a game for local human players, including pacing.
- Human vs LLM seat counts are not restricted: 4+ players total is enough to start; the engine validates the role config against the actual seat count before dealing.

## 2. Roles & Architecture

### 2.1 Roles (JSON-defined)

```json
{
  "id": "werewolf",
  "name": "狼人",
  "faction": "villain",
  "min": 1, "max": 9,
  "night": { "order": 1, "prompt": "...", "action": "target_player",
             "targets": 1, "constraints": { "max_targets": 1 } },
  "day": null
}
```

The engine stores, per seat: role id, faction, alive flag, and role-specific state (e.g., `skillUsed`, `skillTarget`, `isWerewolfLeader`).

### 2.2 Process layout (single Node.js process)

| Module | Responsibility |
|---|---|
| `engine/` | Pure rules engine: state machine, dealing, skill resolution, win check. No I/O, no LLM. Deterministic and unit-testable. |
| `agents/` | LLM wrappers: HostAgent (MC narration, pacing, skill prompts), PlayerAgent (roleplay decisions), SeatAdapter (routes a seat's turn to human or agent). |
| `transport/` | WebSocket server + client SDK; room lobby; reconnect/resume; message schema. |
| `ui/` | Minimal browser client (lobby, game screen, night mask, phase timer) + a CLI client. |
| `llm/` | Model adapters (OpenAI-compatible first), prompt templates, temperature-0 config, token accounting. |

### 2.3 Game state machine

Phases (engine-controlled; each phase has a wall-clock budget from `timing` config):

1. `lobby` — seat fill, host settings (role config, timings, mode)
2. `night` — per role, in `night.order`: prompt → agent/human action → engine resolves
3. `dawn` — engine announces deaths; checks win
4. `day_discussion` — timed open discussion; MC may interject on silence (see §6)
5. `voting` — timed voting; ties → re-vote; no target → skip lynch
6. `night2`… loop until win: all werewolves dead → `victory(villain)`; or all villagers/role players dead → `victory(villain)` (standard rules, configurable)

### 2.4 Skill resolution

Each role's `night.action` is one of: `target_player` (pick 1–N players), `protect` (pick 1 player), `observe` (no target), `pass`. The engine validates target legality (not self, not dead, within `max_targets`, once-per-game flags) before applying. `observe`-type roles (seer/guard) get a result the engine computes and returns to them only.

### 2.5 Win check

Runs at the end of every `dawn` and after every `voting` phase; `win_condition` is a config field so custom variants stay possible.

## 3. LLM Agent Contract

All LLM calls go through `agents/llm-call.ts` which builds a prompt from **prompt templates** (not free text), injects only the information the seat may legally see, and forces `temperature: 0`.

**Prompt context (what an agent sees):**
- role card, faction, alive players, public game log (phase-by-phase, redacted to what the seat can know), and private info (e.g., seer's last check result).
- The Host agent additionally sees full state (it is the MC, not a player).

**Decision output — strict JSON, schema-validated:**

```json
{ "action": "target_player", "targets": ["player_3"],
  "speech": "public narration in character", "confidence": 0.8 }
```

- `speech` is what the agent says aloud (to the room); the engine never re-derives speech.
- Invalid JSON or schema failure → retry once with an error note; second failure → the engine falls back to a **safe default** (e.g., `pass`, or random legal target for werewolf) and logs `agent_fallback`. The game never stalls on LLM failure.
- Determinism: model + temperature 0 + fixed prompt order + no wall-clock in prompts ⇒ same state ⇒ same decision (modulo model-provider nondeterminism, which we accept and document).

### 3.1 Host agent (MC) responsibilities

- Announce phase transitions and results (`dawn` death announcements, vote tallies) — templated narration, occasional flavor.
- **Pacing:** during `day_discussion`, the agent monitors chat cadence (msg/sec) and can nudge: a light prompt after `silence_threshold` seconds, a forced "last call" before the timer ends. Timers always end the phase regardless of agent behavior.
- **Skill prompt generation:** the per-role prompt templates are Host-authored in the UI (editable per role) and rendered by the engine at each night phase.
- **Tie-break / edge cases:** engine rules are primary; the Host narrates engine decisions, it does not decide them.

## 4. Data Model

```
Room { id, status(lobby|playing|finished), hostConfig, seats: Seat[],
       log: Event[], startedAt, endedAt }
Seat { id, kind(human|agent|host), name, role?, state, llm?: {model, persona} }
Event { ts, phase, type, payload, visibleTo: SeatId[]|null }
```

`visibleTo` is the single mechanism for private information (seer results, werewolf pings, role cards). The engine computes visibility; agents and humans never decide what others see.

## 5. Transport & Protocol

- WebSocket (one server) with JSON messages: `join/leave`, `seat_action`, `lobby_update`, `phase_event`, `chat`, `reconnect(token)`.
- Reconnect: seat keeps a token; resume re-syncs `log` filtered by the seat's visibility.
- Timeouts: human seat inaction past phase budget → seat auto-`pass` with a `timeout` log entry; agent seats have a 30s hard timeout with the same fallback.

## 6. Timing / Time Control

Config per phase: `budget_ms`, `softWarnMs` (UI countdown highlight), `hostNudge` (on/off + threshold). The engine owns all clocks; the UI and agents only observe. `hostNudge` makes the Host agent emit a prompt message, never extend time.

## 7. UX

- **Lobby UI:** create/join room, seat list (human/LLM/empty), host settings (role config, timings, mode), "LLM player" and "LLM host" toggles per seat.
- **Game UI:** chat log with phase dividers, public/private message distinction, phase timer bar, "your action" panel for the human seat (target picker + free-text speech box); a "confirm" button gates every human submission (see below).
- **Edit-before-submit (determinism aid):** for LLM seats, the UI shows the LLM's drafted action to the *human controller* (if any) with a 20s confirm window; the draft is editable. Default when unattended: auto-confirm.
- **CLI client:** full parity for headless/LLM-only games (`npx werewolf-cli join <url> --seat <n>`).

## 8. Error Handling

- LLM failure → retry → safe fallback (never blocks the game).
- Human disconnect mid-turn → seat marked `offline`, turn continues, auto-pass on budget expiry.
- State is fully replayable from `Event[]` (determinism guarantee, also powers reconnect).

## 9. Testing

- **Engine:** property-based unit tests — every role action × every seat-state matrix must produce a legal new state; win check exhaustively over small configurations. No LLM in these tests (pure functions).
- **Agents:** contract tests with a mock LLM (fixed responses) verifying prompt construction, redaction (`visibleTo`), and fallback behavior.
- **Integration:** scripted full-game simulation (all-LLM, mock model) end-to-end: lobby → night → day → voting → win. Asserts event log legality and that no private info leaked into public events.
- **Protocol:** WS reconnect + visibility filter tests.

## 10. Out of Scope (first release)

Multi-room matchmaking, role-shop/variants beyond config, voice, cross-device sync beyond reconnect, persistence of finished games, i18n.

## 11. Open Questions (for partner review)

1. LLM provider: default to OpenAI-compatible API only, or support local vLLM (the `vllm-monitor` sibling project suggests local inference is available)?
2. Should LLM seats be **controller-assigned** (a human supervises 1–2 LLM players) from day one, or purely autonomous first?
3. UI scope for v1: is a web UI required for launch, or is the CLI + a minimal web log page enough to start?
