/**
 * Pre-drop conflict prediction: what WOULD this placement collide with?
 *
 * The board used to write the move and recompute conflicts afterwards, so the
 * organizer learned about a double-booked room only once it existed. Predicting
 * BEFORE the write is what lets `admin.agenda.tsx` refuse a blocking placement
 * (DECISIONS.md #70) instead of reporting it after the fact.
 *
 * This is a second CALLER of `findConflicts`, never a second implementation of
 * the overlap rule. If the two could disagree, the Conflicts screen and the drop
 * flow would tell the organizer different things about the same programme.
 *
 * REPLACE, don't append. The proposed placement supersedes the session's current
 * row; appending it leaves the old row in the list, so every no-op re-drop
 * reports the session double-booking its own slot — a conflict that always fires
 * and is never real.
 */
import { findConflicts, type AgendaEntry, type Conflict } from "./conflicts";

export interface ProposedPlacement {
  sessionId: string;
  roomId: string | null;
  startsAt: number;
  endsAt: number;
  /**
   * Display name of the TARGET room. Carrying the id without the name would keep
   * the entry's previous `roomName`, and `findRoomConflicts` labels each bucket
   * from the first entry in it — so a predicted clash could be reported against
   * the name of the room the session is moving OUT of.
   */
  roomName?: string | null;
}

/** The conflicts `proposed` would create, involving only the session being moved. */
export function predictConflicts(
  entries: AgendaEntry[],
  proposed: ProposedPlacement,
): Conflict[] {
  const placement = {
    roomId: proposed.roomId,
    roomName: proposed.roomName ?? null,
    startsAt: proposed.startsAt,
    endsAt: proposed.endsAt,
  };

  let replaced = false;
  const hypothetical: AgendaEntry[] = entries.map((entry) => {
    if (entry.id !== proposed.sessionId) return entry;
    replaced = true;
    // Spread first: participants and trackId travel with the session, since a
    // move changes where and when it happens, never who is on it.
    return { ...entry, ...placement };
  });

  if (!replaced) {
    hypothetical.push({ id: proposed.sessionId, title: proposed.sessionId, ...placement });
  }

  return findConflicts(hypothetical).filter(
    (conflict) => conflict.a.id === proposed.sessionId || conflict.b.id === proposed.sessionId,
  );
}
