/**
 * Agenda conflict detection — pure functions, no I/O, no DB types.
 *
 * Two things can be double-booked on a conference programme:
 *   1. a ROOM  — two sessions in the same room whose times overlap;
 *   2. a PERSON — one speaker (or chair/moderator/panelist) in two sessions at once.
 *
 * Intervals are HALF-OPEN: `[startsAt, endsAt)`. A 10:00–11:00 talk and an
 * 11:00–12:00 talk in the same room do NOT conflict — back-to-back scheduling is
 * the normal case, and flagging it would make the Conflicts screen useless.
 * That single choice is why `adjacent` is a must-NOT-fire test below.
 *
 * Everything works on epoch milliseconds, so multi-day events and DST are not
 * special cases: "same room, different day" simply doesn't overlap, and a session
 * that runs across midnight is one interval like any other.
 *
 * DECISIONS.md #13: Conflicts is a first-class view, and scheduling INTO a
 * conflict is allowed but warned — so this module REPORTS, it never blocks.
 */

/** A programme record as the agenda sees it. `null` times = not yet scheduled. */
export interface AgendaEntry {
  id: string;
  title: string;
  /** Epoch ms, or null when the session has not been placed on the agenda. */
  startsAt: number | null;
  endsAt: number | null;
  roomId: string | null;
  roomName?: string | null;
  /** Flat participants model (DECISIONS.md #20) — every role can double-book. */
  participants?: { id: string; name: string }[];
}

/** An entry that actually occupies time: both ends set, and non-zero length. */
export interface ScheduledEntry extends AgendaEntry {
  startsAt: number;
  endsAt: number;
}

export type ConflictKind = "room" | "speaker";

export interface ConflictSide {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
}

export interface Conflict {
  kind: ConflictKind;
  /** Room id or person id — the resource that is double-booked. */
  resourceId: string;
  /** Human label for that resource, for the Conflicts row. */
  resourceName: string;
  /** Stable ordering: `a` starts first (ties broken by id). */
  a: ConflictSide;
  b: ConflictSide;
  overlapStart: number;
  overlapEnd: number;
  overlapMinutes: number;
}

/**
 * Half-open overlap test. `aEnd === bStart` is adjacency, not overlap.
 * Exported because it is the one rule the whole screen rests on.
 */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Is this entry on the agenda at all? A session with only a start, or with
 * `endsAt <= startsAt`, occupies no interval and can never conflict — reporting
 * it would be a false positive on data the admin has not finished entering.
 */
export function isScheduled(entry: AgendaEntry): entry is ScheduledEntry {
  return (
    typeof entry.startsAt === "number" &&
    typeof entry.endsAt === "number" &&
    Number.isFinite(entry.startsAt) &&
    Number.isFinite(entry.endsAt) &&
    entry.endsAt > entry.startsAt
  );
}

/** Deterministic pair order so the same conflict always renders the same way. */
function orderPair(x: ScheduledEntry, y: ScheduledEntry): [ScheduledEntry, ScheduledEntry] {
  if (x.startsAt !== y.startsAt) return x.startsAt < y.startsAt ? [x, y] : [y, x];
  return x.id <= y.id ? [x, y] : [y, x];
}

function side(entry: ScheduledEntry): ConflictSide {
  return {
    id: entry.id,
    title: entry.title,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
  };
}

function makeConflict(
  kind: ConflictKind,
  resourceId: string,
  resourceName: string,
  x: ScheduledEntry,
  y: ScheduledEntry,
): Conflict {
  const [a, b] = orderPair(x, y);
  const overlapStart = Math.max(a.startsAt, b.startsAt);
  const overlapEnd = Math.min(a.endsAt, b.endsAt);
  return {
    kind,
    resourceId,
    resourceName,
    a: side(a),
    b: side(b),
    overlapStart,
    overlapEnd,
    overlapMinutes: Math.round((overlapEnd - overlapStart) / 60_000),
  };
}

/** Group scheduled entries by a key, dropping entries with no key. */
function bucket(
  entries: ScheduledEntry[],
  keysOf: (entry: ScheduledEntry) => { key: string; label: string }[],
): Map<string, { label: string; entries: ScheduledEntry[] }> {
  const groups = new Map<string, { label: string; entries: ScheduledEntry[] }>();
  for (const entry of entries) {
    for (const { key, label } of keysOf(entry)) {
      const group = groups.get(key);
      if (group) group.entries.push(entry);
      else groups.set(key, { label, entries: [entry] });
    }
  }
  return groups;
}

/**
 * Pairwise sweep inside one bucket.
 *
 * `intervalsOverlap` is the ONLY place the rule lives — deliberately. An earlier
 * draft had a separate `y.startsAt >= x.endsAt` break condition next to the
 * overlap call; the two encoded the same predicate, so mutating the rule left
 * the group-level tests green and only the direct unit test went red. One
 * predicate, used both to decide and to stop.
 *
 * The break is sound because `sorted` is ascending by start: the first `y` that
 * does not overlap `x` starts at or after `x`'s end, and so does everything
 * after it.
 */
function pairsIn(
  kind: ConflictKind,
  resourceId: string,
  resourceName: string,
  entries: ScheduledEntry[],
): Conflict[] {
  const sorted = [...entries].sort(
    (x, y) => x.startsAt - y.startsAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  const found: Conflict[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const x = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const y = sorted[j];
      if (!intervalsOverlap(x.startsAt, x.endsAt, y.startsAt, y.endsAt)) break;
      found.push(makeConflict(kind, resourceId, resourceName, x, y));
    }
  }
  return found;
}

/** Two sessions in the SAME room whose times overlap. */
export function findRoomConflicts(entries: AgendaEntry[]): Conflict[] {
  const scheduled = entries.filter(isScheduled);
  const groups = bucket(scheduled, (entry) =>
    entry.roomId
      ? [{ key: entry.roomId, label: entry.roomName ?? "Room" }]
      : /* Unassigned rooms are not a resource — two unplaced sessions at the
           same time is normal until an admin gives them rooms. */ [],
  );

  const found: Conflict[] = [];
  for (const [roomId, group] of groups) {
    found.push(...pairsIn("room", roomId, group.label, group.entries));
  }
  return found;
}

/** One PERSON in two overlapping sessions, in any participant role. */
export function findSpeakerConflicts(entries: AgendaEntry[]): Conflict[] {
  const scheduled = entries.filter(isScheduled);
  const groups = bucket(scheduled, (entry) =>
    (entry.participants ?? []).map((person) => ({ key: person.id, label: person.name })),
  );

  const found: Conflict[] = [];
  for (const [personId, group] of groups) {
    found.push(...pairsIn("speaker", personId, group.label, group.entries));
  }
  return found;
}

/**
 * Every conflict on the programme, sorted by when the clash starts.
 *
 * A pair CAN appear twice — once as a room clash and once as a speaker clash —
 * because they are two different problems with two different fixes (move the
 * room vs. move the time). Two speakers both double-booked across the same pair
 * likewise yield one row each, named per person.
 */
export function findConflicts(entries: AgendaEntry[]): Conflict[] {
  return [...findRoomConflicts(entries), ...findSpeakerConflicts(entries)].sort(
    (x, y) =>
      x.overlapStart - y.overlapStart ||
      (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) ||
      (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0) ||
      (x.resourceId < y.resourceId ? -1 : x.resourceId > y.resourceId ? 1 : 0),
  );
}

/** Session id → the conflicts it is part of. Drives the inline warning chips. */
export function conflictsBySession(conflicts: Conflict[]): Map<string, Conflict[]> {
  const map = new Map<string, Conflict[]>();
  for (const conflict of conflicts) {
    for (const id of [conflict.a.id, conflict.b.id]) {
      const list = map.get(id);
      if (list) list.push(conflict);
      else map.set(id, [conflict]);
    }
  }
  return map;
}

/** Just the ids, for a cheap `has()` while rendering a list. */
export function conflictedSessionIds(conflicts: Conflict[]): Set<string> {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    ids.add(conflict.a.id);
    ids.add(conflict.b.id);
  }
  return ids;
}

/** "Room · Main Stage" / "Speaker · Sam Speaker" — the Conflicts row label. */
export function conflictLabel(conflict: Conflict): string {
  return conflict.kind === "room"
    ? `Room double-booked · ${conflict.resourceName}`
    : `Speaker double-booked · ${conflict.resourceName}`;
}
