import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { DB } from "~/db/client.server";
import {
  events,
  people,
  rooms,
  sessionParticipants,
  sessions,
  tracks,
  uploads,
} from "~/db/schema";

const PUBLIC_SPEAKER_ROLES = ["speaker", "co_speaker"] as const;

/**
 * Keep this byte-for-byte equivalent to the programme predicate in
 * `app/routes/public.schedule.tsx`, which remains the source of truth while a
 * parallel lane owns it. Directory, detail, and qualification queries all use
 * this one helper so their public boundary cannot drift internally.
 */
export function publicSessionPredicate(eventId: string) {
  return and(
    eq(sessions.eventId, eventId),
    eq(sessions.isAbstract, false),
    eq(sessions.isPublic, true),
    isNotNull(sessions.startsAt),
    isNull(sessions.deletedAt),
  );
}

/**
 * The public session detail route now exists, so a speaker's session list deep
 * links to the session itself rather than dropping the reader on the full
 * schedule to find it again. Kept as a helper so the directory, the profile and
 * the gallery cannot disagree about where a session lives.
 */
export function publicSessionHref(slug: string, sessionId: string): string {
  return `/e/${slug}/schedule/${sessionId}`;
}

/**
 * The ONE place a public headshot URL is spelled. Directory, gallery, profile
 * and both embed widgets call this, so none of them can invent a shape the
 * route does not serve.
 *
 * `version` is the `uploads.id` of the current headshot, never the R2 key. Two
 * properties fall out of that choice:
 *   · the key — which encodes event id, owner id and original filename — never
 *     reaches an anonymous page's HTML or its SSR loader payload, and
 *   · the URL is content-addressed, so `immutable` caching is honest: a new
 *     photo is a different id and therefore a different URL.
 */
export function publicSpeakerPhotoHref(
  slug: string,
  personId: string,
  version: string,
): string {
  return `/e/${slug}/speaker-photo/${personId}/${version}`;
}

/**
 * The publishable-headshot join, written once.
 *
 * The consent gate lives in the JOIN CONDITION rather than in a `where` or in
 * TypeScript after the fact. A person who has not marked their photo
 * publishable joins no `uploads` row at all, so there is no id to leak through
 * a later refactor that forgets a filter — the absence is structural.
 */
function publishableHeadshotJoin() {
  return and(eq(uploads.key, people.headshotKey), eq(people.photoPublishable, true));
}

/** `max()` because the projections group by person; `uploads.key` is unique. */
const photoVersionColumn = sql<string | null>`max(${uploads.id})`;

export interface PublicEventForSpeakers {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface PublicSpeakerSummary {
  id: string;
  displayName: string;
  initials: string;
  groupInitial: string;
  title: string | null;
  company: string | null;
  sessionCount: number;
  /**
   * `uploads.id` of a headshot this person has consented to publish, or null.
   * Null is the normal case for anyone who has not opted in; the surfaces fall
   * back to the monogram exactly as they did before photos existed.
   */
  photoVersion: string | null;
}

export interface PublicSpeakerProfile extends PublicSpeakerSummary {
  bio: string | null;
}

export interface PublicSpeakerSession {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  roomName: string | null;
  trackName: string | null;
  trackColor: string | null;
}

interface ProjectedPerson {
  id: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function publicName(row: ProjectedPerson) {
  const fullName = clean(row.fullName);
  const firstName = clean(row.firstName);
  const lastName = clean(row.lastName);
  const joinedName = [firstName, lastName].filter(Boolean).join(" ");
  /*
   * `||`, not `??`, on the join: `[].join(" ")` is `""`, which is not nullish,
   * so a `??` chain here silently yields an EMPTY display name for a person
   * with no stored names at all — and an empty monogram beside it. The last
   * resort has to be reachable.
   */
  const displayName = fullName ?? (joinedName || "Speaker");
  const fullNameParts = fullName?.split(/\s+/).filter(Boolean) ?? [];
  const surname = lastName ?? fullNameParts.at(-1) ?? null;

  let initials: string;
  if (firstName && lastName) {
    initials = `${firstName[0]}${lastName[0]}`;
  } else if (fullNameParts.length >= 2) {
    initials = `${fullNameParts[0][0]}${fullNameParts.at(-1)?.[0] ?? ""}`;
  } else {
    initials = displayName.slice(0, 2);
  }

  const initial = surname?.[0]?.toLocaleUpperCase("en") ?? "#";
  return {
    displayName,
    initials: initials.toLocaleUpperCase("en"),
    groupInitial: /^[A-Z]$/.test(initial) ? initial : "#",
    // A person with neither stored surname nor full name belongs after named
    // surnames. `displayName` then provides the stable secondary ordering.
    sortSurname: surname?.toLocaleLowerCase("en") ?? "\uffff",
  };
}

export async function getPublicSpeakerEvent(
  db: DB,
  slug: string,
): Promise<PublicEventForSpeakers | null> {
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      timezone: events.timezone,
    })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The people projection is intentionally exhaustive and narrow. In particular,
 * `people.email`, `pronouns`, `links`, and `headshotKey` are never selected, so
 * they cannot accidentally reach React Router's serialised SSR payload.
 *
 * Photos did not relax that. The join contributes `uploads.id` and nothing
 * else — the R2 key stays server-side, and `public.speakers.wire-masking.test`
 * asserts it on the serialised wire in both directions.
 */
export async function listPublicSpeakers(
  db: DB,
  eventId: string,
  query = "",
): Promise<{ speakers: PublicSpeakerSummary[]; total: number }> {
  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      title: people.title,
      company: people.company,
      sessionCount: sql<number>`count(distinct ${sessions.id})`,
      photoVersion: photoVersionColumn,
    })
    .from(people)
    .innerJoin(sessionParticipants, eq(sessionParticipants.personId, people.id))
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .leftJoin(uploads, publishableHeadshotJoin())
    .where(
      and(
        publicSessionPredicate(eventId),
        inArray(sessionParticipants.role, [...PUBLIC_SPEAKER_ROLES]),
      ),
    )
    .groupBy(
      people.id,
      people.fullName,
      people.firstName,
      people.lastName,
      people.title,
      people.company,
    );

  const projected = rows
    .map((row) => {
      const name = publicName(row);
      return {
        id: row.id,
        displayName: name.displayName,
        initials: name.initials,
        groupInitial: name.groupInitial,
        title: row.title,
        company: row.company,
        sessionCount: Number(row.sessionCount),
        photoVersion: row.photoVersion ?? null,
        sortSurname: name.sortSurname,
      };
    })
    .sort(
      (a, b) =>
        a.sortSurname.localeCompare(b.sortSurname, "en", { sensitivity: "base" }) ||
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
    );

  const needle = query.trim().toLocaleLowerCase("en");
  const matches = needle
    ? projected.filter((speaker) =>
        speaker.displayName.toLocaleLowerCase("en").includes(needle),
      )
    : projected;

  return {
    total: projected.length,
    speakers: matches.map(({ sortSurname: _sortSurname, ...speaker }) => speaker),
  };
}

/**
 * This is both the public profile projection and the qualification gate. A
 * person without a matching public-session join produces no row, regardless of
 * whether that person id exists elsewhere in the database.
 */
export async function getPublicSpeakerProfile(
  db: DB,
  eventId: string,
  personId: string,
): Promise<PublicSpeakerProfile | null> {
  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      title: people.title,
      company: people.company,
      bio: people.bio,
      sessionCount: sql<number>`count(distinct ${sessions.id})`,
      photoVersion: photoVersionColumn,
    })
    .from(people)
    .innerJoin(sessionParticipants, eq(sessionParticipants.personId, people.id))
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .leftJoin(uploads, publishableHeadshotJoin())
    .where(
      and(
        eq(people.id, personId),
        publicSessionPredicate(eventId),
        inArray(sessionParticipants.role, [...PUBLIC_SPEAKER_ROLES]),
      ),
    )
    .groupBy(
      people.id,
      people.fullName,
      people.firstName,
      people.lastName,
      people.title,
      people.company,
      people.bio,
    );

  const row = rows[0];
  if (!row) return null;
  const name = publicName(row);
  return {
    id: row.id,
    displayName: name.displayName,
    initials: name.initials,
    groupInitial: name.groupInitial,
    title: row.title,
    company: row.company,
    bio: row.bio,
    sessionCount: Number(row.sessionCount),
    photoVersion: row.photoVersion ?? null,
  };
}

/**
 * Resolve the R2 key for a public photo request, or null.
 *
 * This is the whole authorisation decision for `/e/:slug/speaker-photo/...`,
 * kept here rather than inline in the route so it is unit-testable against a
 * real database in BOTH directions — a publishable speaker resolves, and an
 * unpublishable one with a REAL, CORRECT upload id does not.
 *
 * Four conditions, all required:
 *   · the person qualifies as a public speaker of this event (the same
 *     published-session predicate the directory uses — DECISIONS #58, a public
 *     speaker is derived, never flagged),
 *   · `photo_publishable` is true — the consent gate,
 *   · they have a current `headshot_key`, and
 *   · the requested version is the id of the upload row that key belongs to.
 *
 * The version check is not decoration. Without it, `immutable` on a stale URL
 * would be a lie, and a URL captured while a photo was public would keep
 * resolving after it was replaced.
 */
export async function resolvePublicSpeakerPhotoKey(
  db: DB,
  eventId: string,
  personId: string,
  version: string,
): Promise<string | null> {
  const rows = await db
    .select({ key: uploads.key, uploadId: uploads.id })
    .from(people)
    .innerJoin(sessionParticipants, eq(sessionParticipants.personId, people.id))
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .innerJoin(uploads, publishableHeadshotJoin())
    .where(
      and(
        eq(people.id, personId),
        eq(uploads.id, version),
        publicSessionPredicate(eventId),
        inArray(sessionParticipants.role, [...PUBLIC_SPEAKER_ROLES]),
      ),
    )
    .limit(1);

  return rows[0]?.key ?? null;
}

export async function listPublicSpeakerSessions(
  db: DB,
  eventId: string,
  personId: string,
): Promise<PublicSpeakerSession[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      roomName: rooms.name,
      trackName: tracks.name,
      trackColor: tracks.color,
    })
    .from(sessionParticipants)
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .leftJoin(rooms, eq(rooms.id, sessions.roomId))
    .leftJoin(tracks, eq(tracks.id, sessions.trackId))
    .where(
      and(
        eq(sessionParticipants.personId, personId),
        inArray(sessionParticipants.role, [...PUBLIC_SPEAKER_ROLES]),
        publicSessionPredicate(eventId),
      ),
    )
    .groupBy(
      sessions.id,
      sessions.title,
      sessions.startsAt,
      sessions.endsAt,
      rooms.name,
      tracks.name,
      tracks.color,
    )
    .orderBy(asc(sessions.startsAt), asc(sessions.title));

  return rows.flatMap((row) =>
    row.startsAt
      ? [
          {
            ...row,
            startsAt: row.startsAt,
          },
        ]
      : [],
  );
}
