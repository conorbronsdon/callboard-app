/**
 * Speakers = a PROJECTION over people, not a table of their own — the same
 * decision Sessionboard made (`POST /v1/event/{id}/speakers` returns `Contact`
 * objects, research/sessionboard-api.md §6 #9).
 *
 * "A speaker" here means: a person who is a participant on at least one
 * non-deleted session of this event. That is stricter than "a person associated
 * with the event", which would also return organisers and reviewers — an
 * integration syncing a speaker roster does not want those, and Accelevents
 * would create profiles for them.
 */
import { and, asc, countDistinct, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { people, sessionParticipants, sessions } from "~/db/schema";

import type { Paging } from "./envelope";
import type { ContactInput } from "./serialize";

export interface SpeakerFilters {
  text: string | null;
}

export function normalizeSpeakerFilters(raw: unknown): SpeakerFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { text: null };
  const input = raw as Record<string, unknown>;
  const text = input.text ?? input.q ?? input.search;
  return { text: text ? String(text).trim() || null : null };
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Person ids that are participants on a live session of this event. */
function speakerIdsSubquery(eventId: string) {
  return getDb()
    .select({ personId: sessionParticipants.personId })
    .from(sessionParticipants)
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .where(and(eq(sessions.eventId, eventId), isNull(sessions.deletedAt)));
}

function textClause(text: string | null) {
  if (!text) return undefined;
  const pattern = likePattern(text);
  return or(
    sql`coalesce(${people.fullName}, '') like ${pattern} escape '\\'`,
    sql`${people.email} like ${pattern} escape '\\'`,
    sql`coalesce(${people.company}, '') like ${pattern} escape '\\'`,
  );
}

export async function searchSpeakers(
  eventId: string,
  filters: SpeakerFilters,
  paging: Paging,
): Promise<{ speakers: ContactInput[]; total: number }> {
  const db = getDb();
  const ids = speakerIdsSubquery(eventId);
  const where = and(inArray(people.id, ids), textClause(filters.text));

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(people)
      .where(where)
      .orderBy(asc(people.fullName), asc(people.email))
      .limit(paging.pageSize)
      .offset(paging.offset),
    db.select({ n: countDistinct(people.id) }).from(people).where(where),
  ]);

  return { speakers: rows, total: Number(totals[0]?.n ?? 0) };
}

/**
 * One speaker. Scoped through the same subquery as the search, so a contact id
 * from another event 404s here instead of leaking a profile across events.
 */
export async function getSpeaker(
  eventId: string,
  contactId: string,
): Promise<ContactInput | null> {
  const rows = await getDb()
    .select()
    .from(people)
    .where(and(eq(people.id, contactId), inArray(people.id, speakerIdsSubquery(eventId))))
    .limit(1);
  return rows[0] ?? null;
}

/** The sessions a speaker is on — powers "what is this person speaking at?". */
export async function speakerSessionIds(
  eventId: string,
  contactId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ id: sessions.id })
    .from(sessionParticipants)
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .where(
      and(
        eq(sessionParticipants.personId, contactId),
        eq(sessions.eventId, eventId),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(asc(sessions.startsAt), asc(sessions.title));
  return rows.map((row) => row.id);
}
