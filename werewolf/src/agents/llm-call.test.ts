import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDefaultPrompt,
  callAgentDecision,
  DECISION_SCHEMA_JSON,
  safeDefault,
} from './llm-call';
import { createSeededRng } from '../engine/deck';
import type { AgentPromptContext, Event, SeatState } from '../engine/types';
import standardRolesJson from '../../data/roles-standard.json';
import type { RoleConfig } from '../engine/types';

const roles = standardRolesJson as unknown as RoleConfig[];

function ctxFor(roleId: string, self: string, privateLog: Event[] = []): AgentPromptContext {
  const alive: SeatState[] = [
    { seatId: 'a', kind: 'agent', name: 'A', role: { roleId: 'werewolf', faction: 'villain', alive: true } },
    { seatId: 'b', kind: 'agent', name: 'B', role: { roleId: 'villager', faction: 'villager', alive: true } },
    { seatId: 'c', kind: 'human', name: 'C', role: { roleId: 'villager', faction: 'villager', alive: true } },
  ];
  return {
    role: roles.find((r) => r.id === roleId)!,
    publicLog: [],
    privateLog,
    aliveSeats: alive,
    selfSeatId: self,
  };
}

const publicEvent: Event = {
  ts: 1728000000000,
  phase: 'dawn',
  type: 'dawn_announcement',
  payload: { dead: ['x'] },
  visibleTo: null,
};

describe('callAgentDecision', () => {
  afterEach(() => vi.useRealTimers());

  it('returns a validated AgentAction from a JSON response', async () => {
    const client = vi.fn().mockResolvedValue('{"action":"pass","targets":[],"speech":"I have nothing to add"}');
    const r = await callAgentDecision(client, ctxFor('villager', 'c'), DECISION_SCHEMA_JSON, () => 0);
    expect(r.fallbackUsed).toBe(false);
    expect(r.decision.action).toBe('pass');
    expect(r.decision.speech).toBe('I have nothing to add');
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('retries once on invalid JSON, then falls back', async () => {
    const client = vi.fn().mockResolvedValue('not json at all');
    const r = await callAgentDecision(client, ctxFor('werewolf', 'a'), DECISION_SCHEMA_JSON, () => 1000);
    expect(r.fallbackUsed).toBe(true);
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('falls back on timeout and stays within timeoutMs (mock client hangs)', async () => {
    vi.useFakeTimers();
    const client = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const ctx = ctxFor('werewolf', 'a');
    const p = callAgentDecision(client, ctx, DECISION_SCHEMA_JSON, () => 0, 100);
    await vi.advanceTimersByTimeAsync(150);
    const r = await p;
    expect(r.fallbackUsed).toBe(true);
    expect(r.fallbackReason).toMatch(/timeout/);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('falls back to a legal random target for werewolves, deterministically seeded', async () => {
    const client = vi.fn().mockResolvedValue('oops');
    const ctx = ctxFor('werewolf', 'a');
    const r1 = await callAgentDecision(client, ctx, DECISION_SCHEMA_JSON, () => 1000, 5000, {
      rng: createSeededRng(9),
    });
    const r2 = await callAgentDecision(client, ctx, DECISION_SCHEMA_JSON, () => 1000, 5000, {
      rng: createSeededRng(9),
    });
    expect(r1.decision.targets).toEqual(r2.decision.targets);
    expect(r1.decision.targets[0]).not.toBe('a');
    expect(['b', 'c']).toContain(r1.decision.targets[0]);
  });

  it('rejects targets that are not alive seats', async () => {
    const client = vi.fn().mockResolvedValue('{"action":"target_player","targets":["zzz"]}');
    const r = await callAgentDecision(client, ctxFor('werewolf', 'a'), DECISION_SCHEMA_JSON, () => 1000);
    expect(r.fallbackUsed).toBe(true);
  });
});

describe('safeDefault', () => {
  it('is pass for roles without a night rule', () => {
    const d = safeDefault(ctxFor('villager', 'c'), createSeededRng(1));
    expect(d.action).toBe('pass');
    expect(d.targets).toEqual([]);
  });
});

describe('buildDefaultPrompt', () => {
  it('never emits a wall-clock timestamp', () => {
    const ctx = ctxFor('werewolf', 'a');
    ctx.publicLog = [publicEvent];
    const prompt = buildDefaultPrompt(ctx);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toContain('1728000000000');
    expect(prompt).toContain('狼人杀');
  });

  it('includes private log lines only when provided', () => {
    const wolf = ctxFor('werewolf', 'a', [
      { ts: 1, phase: 'night', type: 'werewolf_kill', payload: { targets: ['b'] }, visibleTo: ['a', 'b'] },
    ]);
    const villager = ctxFor('villager', 'c');
    expect(buildDefaultPrompt(wolf)).toContain('werewolf_kill');
    expect(buildDefaultPrompt(villager)).not.toContain('werewolf_kill');
  });
});
