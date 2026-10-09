import { describe, it, expect } from 'vitest';
import {
  allocateRoleCounts,
  createSeededRng,
  dealRoles,
  validateRoleConfig,
} from './deck';
import type { RoleConfig } from './types';
import standardRolesJson from '../../data/roles-standard.json';

const standardRoles = standardRolesJson as unknown as RoleConfig[];

describe('validateRoleConfig', () => {
  it('accepts the standard preset for 9 seats (plan step 3 replacement)', () => {
    expect(validateRoleConfig(standardRoles, 9)).toEqual([]);
  });

  it('rejects a seat count below the minimum total', () => {
    const violations = validateRoleConfig(standardRoles, 2);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' ')).toMatch(/below the minimum/);
  });

  it('rejects a seat count above the maximum total', () => {
    const violations = validateRoleConfig(standardRoles, 99);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' ')).toMatch(/above the maximum/);
  });

  it('rejects a role whose max is below its min', () => {
    const bad = standardRoles.map((r) => (r.id === 'witch' ? { ...r, min: 2, max: 1 } : r));
    expect(validateRoleConfig(bad, 9).length).toBeGreaterThan(0);
  });

  it('rejects a night action that takes targets without a targets count', () => {
    const bad = standardRoles.map((r) =>
      r.id === 'seer' ? { ...r, night: { ...r.night!, action: 'observe' as const, targets: 0, maxTargets: 1, promptTemplateId: r.night!.promptTemplateId } } : r,
    );
    expect(validateRoleConfig(bad, 9).length).toBeGreaterThan(0);
  });
});

describe('allocateRoleCounts', () => {
  it('produces the exact standard composition for 9 seats', () => {
    const counts = allocateRoleCounts(standardRoles, 9, createSeededRng(1));
    expect(counts.get('werewolf')).toBe(2);
    expect(counts.get('seer')).toBe(1);
    expect(counts.get('witch')).toBe(1);
    expect(counts.get('hunter')).toBe(1);
    expect(counts.get('villager')).toBe(4);
  });

  it('throws on an invalid config', () => {
    expect(() => allocateRoleCounts(standardRoles, 99, createSeededRng(1))).toThrow(
      /invalid role config/,
    );
  });
});

describe('dealRoles', () => {
  it('deals exactly seatCount role ids with the standard composition', () => {
    const dealt = dealRoles(standardRoles, 9, createSeededRng(42));
    expect(dealt).toHaveLength(9);
    const counts = new Map<string, number>();
    for (const id of dealt) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.get('werewolf')).toBe(2);
    expect(counts.get('villager')).toBe(4);
  });

  it('is deterministic for a fixed seed', () => {
    const a = dealRoles(standardRoles, 9, createSeededRng(7));
    const b = dealRoles(standardRoles, 9, createSeededRng(7));
    expect(a).toEqual(b);
  });

  it('produces a different order for a different seed (with high probability)', () => {
    const a = dealRoles(standardRoles, 9, createSeededRng(1));
    const b = dealRoles(standardRoles, 9, createSeededRng(2));
    expect(a).not.toEqual(b);
  });

  it('throws on an invalid seat count', () => {
    expect(() => dealRoles(standardRoles, 99, createSeededRng(1))).toThrow();
  });
});
