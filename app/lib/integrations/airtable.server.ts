/**
 * Airtable one-way MIRROR (DECISIONS.md #2).
 *
 * D1 is the primary store; Airtable is a copy the AIE team can browse. Their
 * API caps at 5 requests/second, which would sink the speed requirement if it
 * sat anywhere near a user write — so it lives on a cron job and NOTHING on a
 * request path calls it. `airtable-write-path.test.ts` proves that by scanning
 * every route module for an import of this file: only the jobs route and the
 * Integrations page may reference it.
 *
 * Queue-with-retries semantics, without a queue binding:
 * - the `sync_state.cursor` is a watermark (max `updated_at` already mirrored);
 * - a run selects rows at or after the watermark, in ten-record batches
 *   (Airtable's per-request cap), upserting on `Callboard ID`;
 * - the watermark advances ONLY if every batch landed, so a failure re-queues
 *   the same rows next run instead of losing them;
 * - 429 and 5xx are retried with exponential backoff inside the run.
 *
 * Cron does not fire in `wrangler dev`, so the only way this is ever observed
 * is `POST /admin/jobs/run?name=airtable-mirror` (AGENTS.md).
 */
import { and, asc, eq, gte, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  events,
  people,
  rooms,
  sessionParticipants,
  sessions,
  tracks,
} from "~/db/schema";
import { appEnv } from "~/lib/env.server";

import { readSyncState, recordSync, type SyncRun } from "./sync-state.server";

export interface AirtableConfig {
  token: string;
  baseId: string;
}

/** Null unless BOTH env vars are present — a half-configured mirror is off. */
export function airtableConfig(): AirtableConfig | null {
  const env = appEnv();
  const token = env.AIRTABLE_TOKEN;
  const baseId = env.AIRTABLE_BASE;
  if (!token || !baseId) return null;
  return { token, baseId };
}

export const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
/** Airtable accepts at most 10 records per create/update request. */
export const AIRTABLE_BATCH_SIZE = 10;
export const AIRTABLE_MAX_ATTEMPTS = 3;
/** The upsert key. One text field in each mirrored table. */
export const AIRTABLE_MERGE_FIELD = "Callboard ID";

export const AIRTABLE_TABLES = {
  speakers: "Speakers",
  sessions: "Sessions",
  submissions: "Submissions",
} as const;
export type AirtableTable = keyof typeof AIRTABLE_TABLES;

export interface AirtableRecord {
  fields: Record<string, unknown>;
}

type FetchLike = typeof fetch;

export interface MirrorDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export interface MirrorResult {
  ok: boolean;
  configured: boolean;
  message: string;
  details: Record<string, unknown>;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * One batch, with retries. Returns the number of records accepted.
 *
 * 429 and 5xx retry with exponential backoff; a 4xx other than 429 is a
 * permanent client error (bad field name, missing table) and retrying it just
 * burns the rate limit, so it fails fast with the body attached — that body is
 * the only way an operator learns their base is missing a column.
 */
async function pushBatch(
  config: AirtableConfig,
  table: string,
  records: AirtableRecord[],
  deps: Required<Pick<MirrorDeps, "fetchImpl" | "sleep">>,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const url = `${AIRTABLE_API_BASE}/${config.baseId}/${encodeURIComponent(table)}`;
  const body = JSON.stringify({
    records,
    typecast: true,
    performUpsert: { fieldsToMergeOn: [AIRTABLE_MERGE_FIELD] },
  });

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= AIRTABLE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await deps.fetchImpl(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body,
      });

      if (response.ok) return { ok: true, count: records.length };

      const text = await response.text();
      lastError = `${response.status} ${text.slice(0, 200)}`;
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, error: lastError };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    // 250ms, 500ms — short enough for a cron slot, long enough to clear a burst.
    if (attempt < AIRTABLE_MAX_ATTEMPTS) await deps.sleep(250 * 2 ** (attempt - 1));
  }
  return { ok: false, error: lastError };
}

interface EventPayload {
  speakers: AirtableRecord[];
  sessions: AirtableRecord[];
  submissions: AirtableRecord[];
  /** Max `updated_at` seen — the next watermark. */
  watermark: number;
}

/**
 * Everything changed since `since`, shaped for Airtable.
 *
 * The comparison is `>=`, not `>`, and that is deliberate. `created_at` and
 * `updated_at` default to `unixepoch() * 1000` — SECOND resolution — so several
 * rows routinely share a timestamp. With `>` , any row written in the same
 * instant as the watermark is skipped on the next run and never mirrored again;
 * the row is silently absent from Airtable forever. `>=` re-sends the boundary
 * rows instead, which is free: every push is a `performUpsert` on
 * `Callboard ID`, so replaying a record is a no-op.
 */
export async function collectMirrorPayload(
  eventId: string,
  since: number,
): Promise<EventPayload> {
  const db = getDb();
  const cursor = new Date(since);

  const [sessionRows, participantRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        status: sessions.status,
        isAbstract: sessions.isAbstract,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        isPublic: sessions.isPublic,
        updatedAt: sessions.updatedAt,
        trackName: tracks.name,
        roomName: rooms.name,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(
        and(
          eq(sessions.eventId, eventId),
          isNull(sessions.deletedAt),
          gte(sessions.updatedAt, cursor),
        ),
      )
      .orderBy(asc(sessions.updatedAt)),
    db
      .select({
        sessionId: sessionParticipants.sessionId,
        fullName: people.fullName,
        email: people.email,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(and(eq(sessions.eventId, eventId), isNull(sessions.deletedAt))),
  ]);

  /*
   * DISPLAY NAMES, not addresses.
   *
   * `Sessions.Speakers` and `Submissions.Speakers` used to be a comma-joined
   * list of contact emails, typed `multilineText` so it did not even read as an
   * email column in the base. That put addresses in all three mirrored tables
   * while `MIRROR_FIELD_SPEC` promised they crossed in one — and `Sessions` is
   * the table an organizer shares by link.
   *
   * A speaker's name is already on the public programme, so the roster column
   * loses nothing by carrying it. The `Speakers` TABLE still carries `Email`,
   * deliberately and in one place, which is what makes the base usable for
   * contacting people. Linking the two is what `Callboard ID` is for.
   *
   * The fallback is the email LOCAL-PART, never the address: `people.full_name`
   * is nullable in the schema even though the seed and both fixtures always set
   * it, and a nameless row must degrade to "sam", not to "sam@example.com".
   */
  const speakerNamesBySession = new Map<string, string[]>();
  for (const row of participantRows) {
    const list = speakerNamesBySession.get(row.sessionId) ?? [];
    list.push(row.fullName?.trim() || row.email.split("@")[0]);
    speakerNamesBySession.set(row.sessionId, list);
  }

  const speakerRows = await db
    .selectDistinct({
      id: people.id,
      email: people.email,
      fullName: people.fullName,
      company: people.company,
      title: people.title,
      bio: people.bio,
      updatedAt: people.updatedAt,
    })
    .from(people)
    .innerJoin(sessionParticipants, eq(sessionParticipants.personId, people.id))
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .where(
      and(
        eq(sessions.eventId, eventId),
        isNull(sessions.deletedAt),
        gte(people.updatedAt, cursor),
      ),
    )
    .orderBy(asc(people.updatedAt));

  let watermark = since;
  const bump = (value: Date) => {
    watermark = Math.max(watermark, value.getTime());
  };

  const speakers: AirtableRecord[] = speakerRows.map((row) => {
    bump(row.updatedAt);
    return {
      fields: {
        [AIRTABLE_MERGE_FIELD]: row.id,
        Email: row.email,
        Name: row.fullName ?? row.email,
        Company: row.company ?? "",
        Title: row.title ?? "",
        Bio: row.bio ?? "",
        "Updated At": iso(row.updatedAt),
      },
    };
  });

  const programme: AirtableRecord[] = [];
  const submissions: AirtableRecord[] = [];

  for (const row of sessionRows) {
    bump(row.updatedAt);
    const record: AirtableRecord = {
      fields: {
        [AIRTABLE_MERGE_FIELD]: row.id,
        Reference: row.friendlyId ?? "",
        Title: row.title,
        Status: row.status,
        Track: row.trackName ?? "",
        Speakers: (speakerNamesBySession.get(row.id) ?? []).join(", "),
        "Updated At": iso(row.updatedAt),
      },
    };
    if (row.isAbstract) {
      submissions.push(record);
    } else {
      record.fields.Room = row.roomName ?? "";
      record.fields["Starts At"] = iso(row.startsAt);
      record.fields["Ends At"] = iso(row.endsAt);
      record.fields.Public = row.isPublic;
      programme.push(record);
    }
  }

  return { speakers, sessions: programme, submissions, watermark };
}

/**
 * The job body. Safe to call with no configuration — that is the common case on
 * a fresh clone and it must read as a clean "not configured", never an error.
 */
export async function runAirtableMirror(deps: MirrorDeps = {}): Promise<MirrorResult> {
  const config = airtableConfig();
  const now = deps.now ?? new Date();

  if (!config) {
    return {
      ok: true,
      configured: false,
      message:
        "airtable-mirror: not configured — set AIRTABLE_TOKEN and AIRTABLE_BASE to enable the mirror.",
      details: { configured: false, pushed: 0 },
    };
  }

  const resolved = {
    // Bare `fetch` stored on an object and invoked as `resolved.fetchImpl(...)`
    // arrives with `this` = the deps object; workerd rejects that as an Illegal
    // invocation (Node's fetch does not care, so unit tests stay green). Wrap it
    // so the call site's receiver never reaches the platform function.
    fetchImpl: deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };

  const eventRows = await getDb().select({ id: events.id, name: events.name }).from(events);
  const perEvent: Record<string, unknown>[] = [];
  let allOk = true;
  let pushed = 0;

  for (const event of eventRows) {
    const state = await readSyncState(event.id, "airtable");
    const since = Number(state?.cursor ?? 0) || 0;
    const payload = await collectMirrorPayload(event.id, since);

    const queued =
      payload.speakers.length + payload.sessions.length + payload.submissions.length;

    if (queued === 0) {
      perEvent.push({ event: event.name, queued: 0, pushed: 0, skipped: "nothing new" });
      continue;
    }

    const errors: string[] = [];
    let sent = 0;

    for (const [table, records] of [
      [AIRTABLE_TABLES.speakers, payload.speakers],
      [AIRTABLE_TABLES.sessions, payload.sessions],
      [AIRTABLE_TABLES.submissions, payload.submissions],
    ] as const) {
      for (const batch of chunk(records, AIRTABLE_BATCH_SIZE)) {
        const result = await pushBatch(config, table, batch, resolved);
        if (result.ok) {
          sent += result.count;
        } else {
          errors.push(`${table}: ${result.error}`);
        }
      }
    }

    const ok = errors.length === 0;
    allOk = allOk && ok;
    pushed += sent;

    const run: SyncRun = {
      at: now.toISOString(),
      ok,
      action: "mirror",
      message: ok
        ? `Mirrored ${sent} record(s) to Airtable.`
        : `Mirrored ${sent} of ${queued}; ${errors.length} batch error(s). ${errors[0]}`,
      counts: {
        speakers: payload.speakers.length,
        sessions: payload.sessions.length,
        submissions: payload.submissions.length,
        pushed: sent,
      },
    };

    await recordSync({
      eventId: event.id,
      provider: "airtable",
      run,
      // The watermark moves ONLY on a clean run. A partial failure re-queues the
      // same rows next time — Airtable upserts on `Callboard ID`, so replaying
      // them is idempotent.
      cursor: ok ? String(payload.watermark) : (state?.cursor ?? null),
    });

    perEvent.push({ event: event.name, queued, pushed: sent, ok, errors });
  }

  return {
    ok: allOk,
    configured: true,
    message: allOk
      ? `airtable-mirror: pushed ${pushed} record(s) across ${eventRows.length} event(s).`
      : `airtable-mirror: completed with errors; ${pushed} record(s) pushed. Unmirrored rows stay queued.`,
    details: { configured: true, pushed, events: perEvent },
  };
}
