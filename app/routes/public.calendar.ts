/** Downloadable public schedule calendar, optionally restricted by session id. */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  events,
  people,
  rooms,
  sessionParticipants,
  sessions,
} from "~/db/schema";
import { buildScheduleIcs, scheduleEndDate } from "~/lib/agenda/schedule-ics";
import { speakerRole, type PublicSpeaker } from "~/lib/agenda/public-schedule";
import { icsUid } from "~/lib/comms/ics";
import type { Route } from "./+types/public.calendar";

function batchesOf<T>(values: readonly T[], size = 50): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getDb();
  const event = await db.query.events.findFirst({ where: eq(events.slug, params.slug) });
  if (!event) throw new Response("Event not found", { status: 404 });

  const url = new URL(request.url);
  const hasSelection = url.searchParams.has("s");
  const requestedIds = [
    ...new Set(
      (url.searchParams.get("s") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);

  const loadRows = (ids: readonly string[] | null) =>
    db
      .select({
        id: sessions.id,
        title: sessions.title,
        description: sessions.description,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        roomName: rooms.name,
      })
      .from(sessions)
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          eq(sessions.isPublic, true),
          isNotNull(sessions.startsAt),
          isNull(sessions.deletedAt),
          ...(ids ? [inArray(sessions.id, ids)] : []),
        ),
      )
      .orderBy(asc(sessions.startsAt), asc(sessions.title))
      .limit(ids ? ids.length : 500);

  const scheduled = hasSelection
    ? requestedIds.length === 0
      ? []
      : (await Promise.all(batchesOf(requestedIds).map((batch) => loadRows(batch))))
          .flat()
          .sort((a, b) => {
            const time = (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0);
            return time || a.title.localeCompare(b.title);
          })
    : await loadRows(null);

  if (hasSelection && requestedIds.length > 0 && scheduled.length === 0) {
    throw new Response("Session not found", { status: 404 });
  }

  const sessionIds = scheduled.map((row) => row.id);
  const participantRows = sessionIds.length
    ? (
        await Promise.all(
          batchesOf(sessionIds).map((batch) =>
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
      ).flat()
    : [];

  const speakersBySession = new Map<string, PublicSpeaker[]>();
  for (const row of participantRows) {
    if (!row.fullName) continue;
    const list = speakersBySession.get(row.sessionId) ?? [];
    list.push({ personId: row.personId, name: row.fullName, title: row.title, company: row.company });
    speakersBySession.set(row.sessionId, list);
  }

  const body = buildScheduleIcs({
    calendarName: `${event.name} Schedule`,
    dtstamp: new Date(),
    events: scheduled.flatMap((row) => {
      if (!row.startsAt) return [];
      const speakers = speakersBySession.get(row.id) ?? [];
      const speakerLine = speakers.length
        ? `Speakers: ${speakers
            .map((speaker) => {
              const role = speakerRole(speaker);
              return role ? `${speaker.name} (${role})` : speaker.name;
            })
            .join("; ")}`
        : "";
      const description = [row.description, speakerLine].filter(Boolean).join("\n\n");
      return [
        {
          uid: icsUid(row.id, url.origin),
          start: row.startsAt,
          end: scheduleEndDate(row.startsAt, row.endsAt),
          summary: row.title,
          description,
          location: row.roomName,
          url: new URL(`/e/${event.slug}/schedule/${row.id}`, url.origin).toString(),
        },
      ];
    }),
  });
  const filenameSlug = event.slug.replace(/[^a-zA-Z0-9_-]/g, "-");
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameSlug}-schedule.ics"`,
    },
  });
}
