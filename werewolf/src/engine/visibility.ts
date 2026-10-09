/**
 * Visibility filtering + private-info leak guard (plan task 14, spec §4).
 *
 * `visibleTo` is the single mechanism for private information: null =
 * public, an array = only those seats may see the event. The transport
 * layer (Task 9) calls assertNoLeak before broadcast so that a private-
 * marked event is never sent to a seat its visibleTo excludes.
 */
import type { Event, RoleConfig } from './types';

/** Events a seat may see: public events plus events explicitly listing it. */
export function eventsVisibleTo(events: Event[], seatId: string): Event[] {
  return events.filter((e) => e.visibleTo === null || e.visibleTo.includes(seatId));
}

/**
 * Defensive runtime check: for every private-marked event
 * (heuristic: payload.private === true), the seat about to receive it must
 * be in the event's visibleTo. Throws a descriptive error on mismatch -
 * never silently drops.
 */
export function assertNoLeak(events: Event[], seatId: string, role: RoleConfig): void {
  for (const e of events) {
    if (e.payload.private !== true) continue;
    if (e.visibleTo !== null && !e.visibleTo.includes(seatId)) {
      throw new Error(
        'visibility leak: private event "' + e.type + '" (role ' + role.id +
        ') is visible to ' + JSON.stringify(e.visibleTo) + ' but not to seat ' + seatId,
      );
    }
  }
}
