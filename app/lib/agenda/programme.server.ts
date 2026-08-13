/**
 * The one query the whole agenda is a view over.
 *
 * DECISIONS.md #3: abstracts and programme sessions are ONE table discriminated
 * by `is_abstract`, and times live on the base record. "The agenda" is therefore
 * `is_abstract = false` rows for this event — scheduled ones AND the unscheduled
 * bucket, because the unscheduled bucket is the whole job to be done after a
 * judge accepts a talk.
 *
 * Every view (List / Day / Week / Track / Room / Conflicts) reads this same
 * shape, so a conflict chip in the Day board and a row on the Conflicts screen
 * can never disagree.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { chunkForBind, getDb } from "~/db/client.server";
import { people, rooms, sessionParticipants, sessions, tracks } from "~/db/schema";
import type { SessionStatus } from "~/db/schema";

import { findConflicts, type AgendaEntry, type Conflict } from "./conflicts";

export interface ProgrammeSession {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  roomId: string | null;
  roomName: string | null;
  trackId: string | null;
  trackName: string | null;
  trackColor: string | null;
  /** Epoch ms — the component formats them in the event timezone. */
  startsAt: number | null;
  endsAt: number | null;
  capacity: number | null;
  isPublic: boolean;
  participants: { id: string; name: string }[];
}

export interface RoomOption {
  id: string;
  name: string;
  capacity: number | null;
}

export interface TrackOption {
  id: string;
  name: string;
  color: string | null;
}

export interface Programme {
  sessions: ProgrammeSession[];
  rooms: RoomOption[];
  tracks: TrackOption[];
  conflicts: Conflict[];
}

/** Cap: a conference programme that exceeds this is not a hackathon demo. */
const MAX_SESSIONS = 500;

export async function loadProgramme(eventId: string): Promise<Programme> {
  const db = getDb();

  const [rowsRaw, roomRows, trackRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        status: sessions.status,
        roomId: sessions.roomId,
        roomName: rooms.name,
        trackId: sessions.trackId,
        trackName: tracks.name,
        trackColor: tracks.color,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        capacity: sessions.capacity,
        isPublic: sessions.isPublic,
      })
      .from(sessions)
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .where(
        and(
          eq(sessions.eventId, eventId),
          eq(sessions.isAbstract, false),
          isNull(sessions.deletedAt),
        ),
      )
      .orderBy(asc(sessions.startsAt), asc(sessions.title))
      .limit(MAX_SESSIONS),
    db
      .select({ id: rooms.id, name: rooms.name, capacity: rooms.capacity })
      .from(rooms)
      .where(eq(rooms.eventId, eventId))
      .orderBy(asc(rooms.order), asc(rooms.name)),
    db
      .select({ id: tracks.id, name: tracks.name, color: tracks.color })
      .from(tracks)
      .where(eq(tracks.eventId, eventId))
      .orderBy(asc(tracks.order), asc(tracks.name)),
  ]);

  const ids = rowsRaw.map((row) => row.id);
  // `ids` is capped by MAX_SESSIONS (500), not by the bound-parameter budget, so
  // one IN clause here is up to 500 variables — five times what D1 accepts.
  const participantRows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select({
            sessionId: sessionParticipants.sessionId,
            personId: people.id,
            fullName: people.fullName,
            email: people.email,
          })
          .from(sessionParticipants)
          .innerJoin(people, eq(people.id, sessionParticipants.personId))
          .where(inArray(sessionParticipants.sessionId, chunk))
          .orderBy(asc(sessionParticipants.order)),
      ),
    )
  ).flat();

  const byId = new Map<string, { id: string; name: string }[]>();
  for (const row of participantRows) {
    const list = byId.get(row.sessionId) ?? [];
    list.push({ id: row.personId, name: row.fullName ?? row.email });
    byId.set(row.sessionId, list);
  }

  const programmeSessions: ProgrammeSession[] = rowsRaw.map((row) => ({
    id: row.id,
    friendlyId: row.friendlyId,
    title: row.title,
    status: row.status,
    roomId: row.roomId,
    roomName: row.roomName,
    trackId: row.trackId,
    trackName: row.trackName,
    trackColor: row.trackColor,
    startsAt: row.startsAt ? row.startsAt.getTime() : null,
    endsAt: row.endsAt ? row.endsAt.getTime() : null,
    capacity: row.capacity,
    isPublic: row.isPublic,
    participants: byId.get(row.id) ?? [],
  }));

  return {
    sessions: programmeSessions,
    rooms: roomRows,
    tracks: trackRows,
    conflicts: findConflicts(programmeSessions as AgendaEntry[]),
  };
}

/** Conflict detection for ONE session against the rest — used to warn on a move. */
export function conflictsInvolving(conflicts: Conflict[], sessionId: string): Conflict[] {
  return conflicts.filter(
    (conflict) => conflict.a.id === sessionId || conflict.b.id === sessionId,
  );
}
