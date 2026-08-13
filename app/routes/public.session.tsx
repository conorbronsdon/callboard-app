/** Public detail for one published programme session. */
import { Link } from "react-router";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { Shell, linkClass } from "~/components/shell";
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
  parseScheduleFilter,
  scheduleFilterQuery,
  toPublicSlot,
  type PublicSpeaker,
} from "~/lib/agenda/public-schedule";
import { PublicSlotChips, PublicSpeakerList } from "./public.schedule";
import type { Route } from "./+types/public.session";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.slot.title} — ${loaderData.event.name}` : "Session" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getDb();
  const event = await db.query.events.findFirst({ where: eq(events.slug, params.slug) });
  if (!event) throw new Response("Session not found", { status: 404 });

  const [row] = await db
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
        eq(sessions.id, params.sessionId),
        eq(sessions.eventId, event.id),
        eq(sessions.isAbstract, false),
        eq(sessions.isPublic, true),
        isNotNull(sessions.startsAt),
        isNull(sessions.deletedAt),
      ),
    )
    .limit(1);
  if (!row?.startsAt) throw new Response("Session not found", { status: 404 });

  const participantRows = await db
    .select({
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
        eq(sessionParticipants.sessionId, row.id),
        inArray(sessionParticipants.role, ["speaker", "co_speaker"]),
      ),
    )
    .orderBy(asc(sessionParticipants.order), asc(people.fullName));
  const speakers: PublicSpeaker[] = participantRows.flatMap((person) =>
    person.fullName
      ? [{ personId: person.personId, name: person.fullName, title: person.title, company: person.company }]
      : [],
  );
  const slot = toPublicSlot({ ...row, startsAt: row.startsAt }, speakers, event.timezone);
  const day = dayKeyOf(row.startsAt, event.timezone);
  const safeQuery = scheduleFilterQuery(
    parseScheduleFilter(new URL(request.url).searchParams),
  );

  return {
    event: { name: event.name, slug: event.slug, timezone: event.timezone },
    slot,
    dayLabel: formatDayLabel(day, event.timezone),
    backHref: `/e/${event.slug}/schedule${safeQuery ? `?${safeQuery}` : ""}#public-session-${row.id}`,
  };
}

export default function PublicSession({ loaderData }: Route.ComponentProps) {
  const { event, slot, dayLabel, backHref } = loaderData;
  return (
    <Shell
      title={slot.title}
      titleSize="display"
      nav={[
        { to: `/e/${event.slug}`, label: "Overview", end: true },
        { to: `/e/${event.slug}/schedule`, label: "Schedule" },
        { to: `/e/${event.slug}/speakers`, label: "Speakers" },
      ]}
    >
      <article
        data-public-session-detail={slot.id}
        className="rounded-xl border border-gray-200 bg-white p-5 shadow-card sm:p-7 dark:border-gray-800 dark:bg-gray-900"
      >
        <p className="font-mono text-sm font-medium tabular-nums text-gray-700 dark:text-gray-300">
          {dayLabel} · {slot.timeLabel}
        </p>
        <div className="mt-3">
          <PublicSlotChips slot={slot} />
        </div>
        {slot.description ? (
          <p className="mt-5 whitespace-pre-wrap text-base leading-7 text-gray-700 dark:text-gray-300">
            {slot.description}
          </p>
        ) : null}
        <PublicSpeakerList sessionId={slot.id} speakers={slot.speakers} eventSlug={event.slug} />
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <a className={linkClass} href={`/e/${event.slug}/schedule.ics?s=${encodeURIComponent(slot.id)}`}>
            Add to calendar (.ics)
          </a>
          <Link className={linkClass} to={backHref}>
            ← Back to schedule
          </Link>
        </div>
      </article>
    </Shell>
  );
}
