/**
 * The Accelevents surface: data loading for the CSV pair, and the optional
 * Enterprise-tier API push.
 *
 * DECISIONS.md #24 — this ships as an in-product Integrations page, not a bare
 * download link. The CSV pair is ALWAYS generated (it is the only path that can
 * link speakers to sessions, and it works on every paying tier); the API push is
 * an accelerator that appears only when `ACCELEVENTS_API_KEY` is set, and the
 * page says plainly that it cannot do the linking.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  events,
  formats,
  people,
  rooms,
  sessionParticipants,
  sessionTags,
  sessions,
  tags,
  tracks,
} from "~/db/schema";
import { appEnv } from "~/lib/env.server";

import {
  apiFormatFor,
  accelApiDateTime,
  buildSessionsCsv,
  buildSpeakersCsv,
  locationIds,
  splitName,
  stripHtml,
  type AccelSessionInput,
  type AccelSpeakerInput,
  type CsvBuild,
} from "./accelevents-csv";
import { recordSync, type SyncRun } from "./sync-state.server";

export const ACCELEVENTS_API_BASE = "https://api.accelevents.com";
/** Their spec's securityScheme header name is `Key`, not `Authorization` (§2). */
export const ACCELEVENTS_AUTH_HEADER = "Key";
/** Error code for "Speaker already exist with same email" — our upsert signal (§4). */
export const ACCELEVENTS_DUPLICATE_EMAIL_CODE = 4068906;

export interface AccelConfig {
  apiKey: string;
  eventUrl: string;
}

/** Null unless BOTH the key and their event slug are configured. */
export function accelConfig(): AccelConfig | null {
  const env = appEnv();
  const apiKey = env.ACCELEVENTS_API_KEY;
  const eventUrl = env.ACCELEVENTS_EVENT_URL;
  if (!apiKey || !eventUrl) return null;
  return { apiKey, eventUrl };
}

/* ----------------------------------------------------------- data load */

export interface AccelExportData {
  timeZone: string;
  rooms: { id: string; name: string }[];
  speakers: AccelSpeakerInput[];
  sessions: AccelSessionInput[];
}

/**
 * What gets pushed: the PROGRAMME (`is_abstract = false`, not deleted) and the
 * people on it. Abstracts stay out — a registration platform wants the agenda
 * that was decided, not the submissions that were considered.
 *
 * Plain `Promise.all`, never `db.batch`: these are joined selects, and drizzle
 * maps batch results by object key, where a join's duplicate `name` columns
 * collapse (see app/routes/admin.submission.tsx).
 */
export async function loadAccelExportData(eventId: string): Promise<AccelExportData> {
  const db = getDb();

  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const timeZone = event?.timezone ?? "America/Los_Angeles";

  const [sessionRows, roomRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        title: sessions.title,
        description: sessions.description,
        capacity: sessions.capacity,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        roomId: sessions.roomId,
        trackName: tracks.name,
        formatName: formats.name,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(formats, eq(formats.id, sessions.formatId))
      .where(
        and(
          eq(sessions.eventId, eventId),
          eq(sessions.isAbstract, false),
          isNull(sessions.deletedAt),
        ),
      )
      .orderBy(asc(sessions.startsAt), asc(sessions.title)),
    db
      .select({ id: rooms.id, name: rooms.name })
      .from(rooms)
      .where(eq(rooms.eventId, eventId))
      .orderBy(asc(rooms.order), asc(rooms.name)),
  ]);

  const tagRows = await db
    .select({ sessionId: sessionTags.sessionId, name: tags.name })
    .from(sessionTags)
    .innerJoin(tags, eq(tags.id, sessionTags.tagId))
    .innerJoin(sessions, eq(sessions.id, sessionTags.sessionId))
    .where(and(eq(sessions.eventId, eventId), eq(sessions.isAbstract, false)))
    .orderBy(asc(tags.order), asc(tags.name));

  const tagsBySession = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagsBySession.get(row.sessionId) ?? [];
    list.push(row.name);
    tagsBySession.set(row.sessionId, list);
  }

  const participantRows = await db
    .select({
      sessionId: sessionParticipants.sessionId,
      role: sessionParticipants.role,
      order: sessionParticipants.order,
      personId: people.id,
      email: people.email,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      pronouns: people.pronouns,
      title: people.title,
      company: people.company,
      bio: people.bio,
      links: people.links,
    })
    .from(sessionParticipants)
    .innerJoin(people, eq(people.id, sessionParticipants.personId))
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.isAbstract, false),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(asc(sessionParticipants.order), asc(people.email));

  /*
   * Accelevents' "Primary Speaker" column means speaker-MODERATOR, not
   * "the person who submitted" (§7a). Mapping our primary submitter onto it
   * would label every speaker a moderator in their UI, so the split follows
   * their semantics: chairpersons and moderators are Primary, everybody else
   * is an ordinary speaker.
   */
  const byEmail = new Map<string, AccelSpeakerInput>();
  const primary = new Map<string, string[]>();
  const secondary = new Map<string, string[]>();

  for (const row of participantRows) {
    if (!byEmail.has(row.email)) {
      byEmail.set(row.email, {
        email: row.email,
        fullName: row.fullName,
        firstName: row.firstName,
        lastName: row.lastName,
        pronouns: row.pronouns,
        title: row.title,
        company: row.company,
        bio: row.bio,
        links: row.links,
      });
    }
    const bucket = row.role === "moderator" || row.role === "chairperson" ? primary : secondary;
    const list = bucket.get(row.sessionId) ?? [];
    list.push(row.email);
    bucket.set(row.sessionId, list);
  }

  return {
    timeZone,
    rooms: roomRows,
    speakers: [...byEmail.values()].sort((a, b) => (a.email < b.email ? -1 : 1)),
    sessions: sessionRows.map((row) => ({
      title: row.title,
      description: row.description,
      formatName: row.formatName,
      trackName: row.trackName,
      roomId: row.roomId,
      startsAt: row.startsAt ? row.startsAt.getTime() : null,
      endsAt: row.endsAt ? row.endsAt.getTime() : null,
      capacity: row.capacity,
      tags: tagsBySession.get(row.id) ?? [],
      primaryEmails: primary.get(row.id) ?? [],
      secondaryEmails: secondary.get(row.id) ?? [],
    })),
  };
}

export interface AccelCsvPair {
  speakers: CsvBuild;
  sessions: CsvBuild;
}

export async function buildAccelCsvPair(eventId: string): Promise<AccelCsvPair> {
  const data = await loadAccelExportData(eventId);
  return {
    speakers: buildSpeakersCsv(data.speakers),
    sessions: buildSessionsCsv(data.sessions, {
      timeZone: data.timeZone,
      locationIds: locationIds(data.rooms),
    }),
  };
}

/* -------------------------------------------------------------- push */

export interface PushResult {
  ok: boolean;
  message: string;
  counts: { speakersCreated: number; speakersExisting: number; sessionsCreated: number; failed: number };
  errors: string[];
}

type FetchLike = typeof fetch;

/**
 * Optional Enterprise-tier push.
 *
 * Speakers are UPSERTED through their own error code: attempt create, and treat
 * `4068906` ("Speaker already exist with same email") as success rather than a
 * failure (§4). That is the only idempotency handle their API offers.
 *
 * ⚠️ Sessions created here are NOT linked to speakers, because their API has no
 * endpoint that can do it (§5) — 47 session fields, zero speaker fields, and
 * every join slug 404s. The CSV pair remains the complete path. The UI says so.
 *
 * Requests are serialized with a delay: their rate limits are undocumented and
 * their docs host started 429ing after ~19 rapid requests (§6).
 */
export async function pushToAccelevents(options: {
  eventId: string;
  config: AccelConfig;
  fetchImpl?: FetchLike;
  /** Injected so tests do not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}): Promise<PushResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? new Date();
  const data = await loadAccelExportData(options.eventId);

  const counts = { speakersCreated: 0, speakersExisting: 0, sessionsCreated: 0, failed: 0 };
  const errors: string[] = [];

  const base = `${ACCELEVENTS_API_BASE}/rest/host/event/${encodeURIComponent(options.config.eventUrl)}`;
  const headers = {
    [ACCELEVENTS_AUTH_HEADER]: options.config.apiKey,
    "content-type": "application/json",
  };

  for (const speaker of data.speakers) {
    const { first, last } = splitName(speaker);
    try {
      const response = await fetchImpl(`${base}/speaker`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          firstName: first,
          lastName: last,
          email: speaker.email,
          bio: stripHtml(speaker.bio),
          company: speaker.company ?? "",
          title: speaker.title ?? "",
          pronouns: speaker.pronouns ?? "",
        }),
      });
      const text = await response.text();
      if (response.ok) {
        counts.speakersCreated += 1;
      } else if (text.includes(String(ACCELEVENTS_DUPLICATE_EMAIL_CODE))) {
        // Already there — the upsert signal, not a failure.
        counts.speakersExisting += 1;
      } else {
        counts.failed += 1;
        errors.push(`speaker ${speaker.email}: ${response.status} ${text.slice(0, 120)}`);
      }
    } catch (error) {
      counts.failed += 1;
      errors.push(
        `speaker ${speaker.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(1000);
  }

  for (const session of data.sessions) {
    if (session.startsAt === null || session.endsAt === null) continue;
    try {
      const response = await fetchImpl(`${base}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionTypeFormat: "IN_PERSON",
          title: session.title,
          // Their API takes ONE `yyyy/MM/dd HH:mm` field; the CSV splits it into
          // three columns in a different order. Two mappers, never one.
          startTime: accelApiDateTime(session.startsAt, data.timeZone),
          endTime: accelApiDateTime(session.endsAt, data.timeZone),
          format: apiFormatFor(session.formatName),
          description: stripHtml(session.description),
          ...(session.capacity === null ? {} : { capacity: session.capacity }),
        }),
      });
      if (response.ok) {
        counts.sessionsCreated += 1;
      } else {
        counts.failed += 1;
        const text = await response.text();
        errors.push(`session "${session.title}": ${response.status} ${text.slice(0, 120)}`);
      }
    } catch (error) {
      counts.failed += 1;
      errors.push(
        `session "${session.title}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(1000);
  }

  const ok = counts.failed === 0;
  const message = ok
    ? `Pushed ${counts.speakersCreated} new speakers (${counts.speakersExisting} already existed) and ${counts.sessionsCreated} sessions. Speaker↔session links still require the CSV pair.`
    : `${counts.failed} request(s) failed. ${errors[0] ?? ""}`;

  const run: SyncRun = {
    at: now.toISOString(),
    ok,
    action: "api-push",
    message,
    counts: {
      speakers_created: counts.speakersCreated,
      speakers_existing: counts.speakersExisting,
      sessions_created: counts.sessionsCreated,
      failed: counts.failed,
    },
  };
  await recordSync({ eventId: options.eventId, provider: "accelevents", run });

  return { ok, message, counts, errors };
}

/** Record that the CSV pair was generated, so the panel has a history to show. */
export async function recordCsvGeneration(
  eventId: string,
  pair: AccelCsvPair,
  now: Date = new Date(),
): Promise<void> {
  await recordSync({
    eventId,
    provider: "accelevents",
    run: {
      at: now.toISOString(),
      ok: true,
      action: "csv-pair",
      message: `Generated speakers.csv (${pair.speakers.rowCount} rows) and sessions.csv (${pair.sessions.rowCount} rows).`,
      counts: {
        speakers: pair.speakers.rowCount,
        sessions: pair.sessions.rowCount,
        skipped: pair.sessions.skipped.length,
      },
    },
  });
}
