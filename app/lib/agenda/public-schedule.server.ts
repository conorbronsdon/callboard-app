/**
 * The public schedule query, shared by the full public page and the iframe
 * widget so the two surfaces cannot drift (EMB-16).
 *
 * ONLY published sessions appear (the WS4 publish toggle sets `is_public`), so
 * an organiser can rearrange the programme all week without leaking a
 * half-built agenda to attendees.
 *
 * This module owns the QUERY only. Filtering, faceting and the personal
 * itinerary live in the pure `~/lib/agenda/public-schedule` module beside it,
 * and the interactive chrome stays in the route — an iframe widget wants
 * neither a search box nor a localStorage-backed itinerary.
 */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  events,
  formats,
  people,
  rooms,
  sessionParticipants,
  sessions,
  tracks,
} from "~/db/schema";
import { dayKeyOf, formatDayLabel } from "~/lib/agenda/schedule";
import {
  facetsOf,
  toPublicSlot,
  type PublicDay,
  type PublicSlot,
  type PublicSpeaker,
} from "~/lib/agenda/public-schedule";

export interface PublicScheduleData {
  event: { name: string; slug: string; timezone: string };
  days: PublicDay[];
  total: number;
  facets: ReturnType<typeof facetsOf>;
}

export async function loadPublicSchedule(slug: string): Promise<PublicScheduleData> {
  const db = getDb();
  const event = await db.query.events.findFirst({ where: eq(events.slug, slug) });
  if (!event) throw new Response("Event not found", { status: 404 });

  /** The agenda is a view over sessions that have times set and are public. */
  const scheduled = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      description: sessions.description,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      roomName: rooms.name,
      trackName: tracks.name,
      trackColor: tracks.color,
      formatName: formats.name,
    })
    .from(sessions)
    .leftJoin(rooms, eq(rooms.id, sessions.roomId))
    .leftJoin(tracks, eq(tracks.id, sessions.trackId))
    .leftJoin(formats, eq(formats.id, sessions.formatId))
    .where(
      and(
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, false),
        eq(sessions.isPublic, true),
        isNotNull(sessions.startsAt),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(asc(sessions.startsAt), asc(sessions.title))
    .limit(500);

  /*
   * Keep one row per session, then load presenters in bounded batches. A join
   * above would duplicate sessions; a large IN clause exceeds D1's bind budget.
   * The repeated event predicate is intentional defence in depth.
   */
  const sessionIds = scheduled.map((row) => row.id);
  const participantBatches: string[][] = [];
  for (let offset = 0; offset < sessionIds.length; offset += 50) {
    participantBatches.push(sessionIds.slice(offset, offset + 50));
  }
  const participantRows = (
    await Promise.all(
      participantBatches.map((batch) =>
        db
          .select({
            sessionId: sessionParticipants.sessionId,
            personId: people.id,
            fullName: people.fullName,
            title: people.title,
            company: people.company,
          })
          .from(sessionParticipants)
          .innerJoin(people, eq(people.id, sessionParticipants.personId))
          .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
          .where(
            and(
              eq(sessions.eventId, event.id),
              inArray(sessionParticipants.sessionId, batch),
              inArray(sessionParticipants.role, ["speaker", "co_speaker"]),
            ),
          )
          .orderBy(asc(sessionParticipants.order), asc(people.fullName)),
      ),
    )
  ).flat();

  const speakersBySession = new Map<string, PublicSpeaker[]>();
  for (const row of participantRows) {
    if (!row.fullName) continue;
    const speakerList = speakersBySession.get(row.sessionId) ?? [];
    speakerList.push({ personId: row.personId, name: row.fullName, title: row.title, company: row.company });
    speakersBySession.set(row.sessionId, speakerList);
  }

  const timeZone = event.timezone;
  const byDay = new Map<string, PublicSlot[]>();
  for (const row of scheduled) {
    if (!row.startsAt) continue;
    const day = dayKeyOf(row.startsAt, timeZone);
    const list = byDay.get(day) ?? [];
    list.push(
      toPublicSlot({ ...row, startsAt: row.startsAt }, speakersBySession.get(row.id) ?? [], timeZone),
    );
    byDay.set(day, list);
  }

  const days: PublicDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, daySessions]) => ({
      day,
      label: formatDayLabel(day, timeZone),
      sessions: daySessions,
    }));

  return {
    event: { name: event.name, slug: event.slug, timezone: timeZone },
    days,
    total: scheduled.length,
    facets: facetsOf(days),
  };
}
