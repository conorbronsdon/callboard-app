import {
  findRoomConflicts,
  findSpeakerConflicts,
  isScheduled,
  type AgendaEntry,
} from "./conflicts";
import {
  DEFAULT_DURATION_MINUTES,
  slotEpoch,
  type DayKey,
  type TimeKey,
} from "./schedule";

/**
 * An entry the planner may place. `durationMinutes` is declared rather than
 * cast off `AgendaEntry` at the use site: an unscheduled session has null times
 * and so carries no derivable length, and a caller that knows the intended
 * length needs a typed way to say so instead of an untyped property probe.
 */
export interface AutoPlaceEntry extends AgendaEntry {
  durationMinutes?: number;
}

export interface AutoPlacement {
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
}

export interface AutoPlacementPlan {
  placements: AutoPlacement[];
  unplaced: { sessionId: string; title: string }[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function candidateDuration(entry: AutoPlaceEntry, fallback: number): number {
  const supplied = entry.durationMinutes;
  return typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0
    ? supplied
    : fallback;
}

function involvesSession(
  conflicts: ReturnType<typeof findRoomConflicts>,
  sessionId: string,
): boolean {
  return conflicts.some(
    (conflict) => conflict.a.id === sessionId || conflict.b.id === sessionId,
  );
}

export function planAutoPlacement({
  entries,
  rooms,
  days,
  slots,
  timeZone,
  defaultDurationMinutes = DEFAULT_DURATION_MINUTES,
}: {
  entries: AutoPlaceEntry[];
  rooms: { id: string; name?: string | null }[];
  days: DayKey[];
  slots: TimeKey[];
  timeZone: string;
  defaultDurationMinutes?: number;
}): AutoPlacementPlan {
  const candidates = entries
    .filter((entry) => !isScheduled(entry))
    .sort((a, b) => compareText(a.title, b.title) || compareText(a.id, b.id));
  const orderedDays = [...days].sort(compareText);
  const orderedSlots = [...slots].sort(compareText);
  const working: AutoPlaceEntry[] = entries.filter(isScheduled);
  const placements: AutoPlacement[] = [];
  const unplaced: { sessionId: string; title: string }[] = [];

  for (const entry of candidates) {
    const duration = candidateDuration(entry, defaultDurationMinutes);
    let placement: AutoPlacement | null = null;

    candidateSlots: for (const day of orderedDays) {
      for (const slot of orderedSlots) {
        const startsAt = slotEpoch(day, slot, timeZone);
        if (startsAt === null) continue;
        const endsAt = startsAt + duration * 60_000;
        for (const room of rooms) {
          const tentative: AutoPlaceEntry = {
            ...entry,
            roomId: room.id,
            roomName: room.name ?? null,
            startsAt,
            endsAt,
          };
          const withTentative = [...working, tentative];
          const roomConflicts = findRoomConflicts(withTentative);
          const speakerConflicts = findSpeakerConflicts(withTentative);
          if (
            involvesSession(roomConflicts, entry.id) ||
            involvesSession(speakerConflicts, entry.id)
          ) {
            continue;
          }

          placement = { sessionId: entry.id, roomId: room.id, startsAt, endsAt };
          working.push(tentative);
          break candidateSlots;
        }
      }
    }

    if (placement) placements.push(placement);
    else unplaced.push({ sessionId: entry.id, title: entry.title });
  }

  return { placements, unplaced };
}
