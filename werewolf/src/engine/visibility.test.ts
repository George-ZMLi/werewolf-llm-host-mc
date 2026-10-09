import { describe, expect, it } from 'vitest';
import type { Event, RoleConfig } from './types';
import { assertNoLeak, eventsVisibleTo } from './visibility';

const WOLF: RoleConfig = {
  id: 'werewolf',
  name: 'werewolf',
  faction: 'villain',
  min: 2,
  max: 2,
};

function ev(type: string, payload: Record<string, unknown>, visibleTo: string[] | null): Event {
  return { ts: 1, phase: 'night', type, payload, visibleTo };
}

describe('eventsVisibleTo', () => {
  it('includes events with visibleTo=null and events whose visibleTo includes the seat', () => {
    const events: Event[] = [
      ev('phase_change', { phase: 'night' }, null),
      ev('werewolf_kill', { target: 's0' }, ['s1']),
      ev('seer_result', { target: 's0', alive: true }, ['s2']),
    ];
    const seen = eventsVisibleTo(events, 's1');
    expect(seen.map((e) => e.type)).toEqual(['phase_change', 'werewolf_kill']);
  });

  it('excludes events whose visibleTo is set and does not include the seat', () => {
    const events: Event[] = [
      ev('werewolf_kill', { target: 's0' }, ['s1']),
      ev('phase_change', { phase: 'dawn' }, null),
    ];
    const seen = eventsVisibleTo(events, 's3');
    expect(seen.map((e) => e.type)).toEqual(['phase_change']);
  });
});

describe('assertNoLeak', () => {
  it('throws if a private-marked event is exposed to a seat not in visibleTo', () => {
    const events = [ev('role_assigned', { private: true, roleId: 'werewolf' }, ['s1'])];
    expect(() => assertNoLeak(events, 's2', WOLF)).toThrow(/visibility leak.*werewolf.*s2/);
  });

  it('does not throw when the seat is listed in the private event visibleTo', () => {
    const events = [ev('role_assigned', { private: true, roleId: 'werewolf' }, ['s1', 's2'])];
    expect(() => assertNoLeak(events, 's2', WOLF)).not.toThrow();
  });

  it('ignores events without the private marker', () => {
    const events = [ev('phase_change', { phase: 'night' }, ['s1'])];
    expect(() => assertNoLeak(events, 's2', WOLF)).not.toThrow();
  });
});
