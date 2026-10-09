import type { RoleConfig } from './types';

/**
 * Deterministic PRNG (mulberry32). All engine randomness flows through an
 * injected rng so identical seeds ⇒ identical deals (spec §3 determinism).
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Validate a role config against a seat count (spec §2.1: the engine
 * validates the role config against the actual seat count before dealing).
 *
 * Returns human-readable violation strings; empty array = valid.
 */
export function validateRoleConfig(config: RoleConfig[], seatCount: number): string[] {
  const violations: string[] = [];

  if (!Number.isInteger(seatCount) || seatCount < 1) {
    violations.push(`seatCount must be an integer >= 1, got ${seatCount}`);
  }

  const seen = new Set<string>();
  let minTotal = 0;
  let maxTotal = 0;

  for (const role of config) {
    if (!role.id || typeof role.id !== 'string') {
      violations.push('role entry missing id');
      continue;
    }
    if (seen.has(role.id)) {
      violations.push(`duplicate role id "${role.id}"`);
      continue;
    }
    seen.add(role.id);

    if (!Number.isInteger(role.min) || role.min < 0) {
      violations.push(`role ${role.id}: min must be a non-negative integer`);
    }
    if (!Number.isInteger(role.max) || role.max < 0) {
      violations.push(`role ${role.id}: max must be a non-negative integer`);
    }
    if (Number.isInteger(role.min) && Number.isInteger(role.max) && role.max < role.min) {
      violations.push(`role ${role.id}: max (${role.max}) must be >= min (${role.min})`);
    }

    const night = role.night;
    if (night && night.action !== 'pass') {
      if (!Number.isInteger(night.targets) || night.targets < 1) {
        violations.push(`role ${role.id}: night.targets must be >= 1 for action "${night.action}"`);
      }
      if (night.maxTargets < night.targets) {
        violations.push(`role ${role.id}: maxTargets (${night.maxTargets}) must be >= targets (${night.targets})`);
      }
      if (typeof night.order !== 'number' || night.order < 1) {
        violations.push(`role ${role.id}: night.order must be >= 1`);
      }
    }

    if (Number.isInteger(role.min)) minTotal += role.min;
    if (Number.isInteger(role.max) && role.max > 0) maxTotal += role.max;
  }

  if (Number.isInteger(seatCount) && seatCount >= 1) {
    if (seatCount < minTotal) {
      violations.push(`seatCount ${seatCount} is below the minimum total ${minTotal} (sum of role mins)`);
    }
    if (seatCount > maxTotal) {
      violations.push(`seatCount ${seatCount} is above the maximum total ${maxTotal} (sum of role maxes)`);
    }
  }

  return violations;
}

/**
 * Choose per-role counts that sum to seatCount, staying within [min, max].
 * Deterministic for a given rng. Throws if validation fails.
 */
export function allocateRoleCounts(
  config: RoleConfig[],
  seatCount: number,
  rng: () => number,
): Map<string, number> {
  const violations = validateRoleConfig(config, seatCount);
  if (violations.length > 0) {
    throw new Error('invalid role config: ' + violations.join('; '));
  }

  const counts = new Map<string, number>(config.map((r) => [r.id, r.min]));
  let remaining = seatCount - config.reduce((sum, r) => sum + r.min, 0);

  while (remaining > 0) {
    const candidates = config.filter((r) => (counts.get(r.id) ?? 0) < r.max);
    if (candidates.length === 0) {
      throw new Error('role allocation impossible: no role has remaining capacity');
    }
    const pick = candidates[Math.floor(rng() * candidates.length)];
    counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
    remaining--;
  }
  return counts;
}

/**
 * Deal a shuffled list of role ids (one per seat) from a role config.
 *
 * - Validates the config first (throws on violation).
 * - Deterministic: same config + seatCount + rng sequence ⇒ same deal.
 */
export function dealRoles(config: RoleConfig[], seatCount: number, rng: () => number): string[] {
  const counts = allocateRoleCounts(config, seatCount, rng);

  const roles: string[] = [];
  for (const role of config) {
    for (let i = 0; i < (counts.get(role.id) ?? 0); i++) {
      roles.push(role.id);
    }
  }

  // Fisher-Yates shuffle driven by the injected rng.
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}
