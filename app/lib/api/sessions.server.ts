/**
 * The sessions half of `/v1` — search, read, create, update, soft-delete,
 * restore, bulk.
 *
 * Thin over the existing model: abstracts and programme sessions are ONE table
 * discriminated by `is_abstract` (DECISIONS.md #3), so a single set of handlers
 * serves both "list the CFP" and "list the agenda", exactly as Sessionboard's
 * own API does.
 *
 * ⚠️ Joined SELECTs are run with `Promise.all`, never `db.batch`. Drizzle emits
 * joins with NO column aliases; `db.batch()` returns OBJECT rows which drizzle
 * maps with `Object.values()`, so `name` from four joined metadata tables
 * collapses and silently shifts every column after it (see the header of
 * app/routes/admin.submission.tsx — it cost that lane a wrong `forms.schema`).
 * Batch only statements whose result-column names are unique.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  recordGateOverride,
  type GateOverrideActor,
} from "~/lib/admin/gate-overrides.server";
import { blockingConflicts, conflictLabel } from "~/lib/agenda/conflicts";
import { isSessionInformed } from "~/lib/agenda/informed-gate.server";
import { predictConflicts } from "~/lib/agenda/predict";
import { loadProgramme } from "~/lib/agenda/programme.server";
import { emitWebhook } from "~/lib/webhooks/webhooks.server";
import {
  formats,
  levels,
  people,
  rooms,
  sessionParticipants,
  sessionTags,
  sessions,
  tags,
  tracks,
  SESSION_STATUSES,
  type SessionStatus,
} from "~/db/schema";

import type {
  CompositionTargetInput,
  ParticipantInput,
  SessionInput,
} from "./serialize";
import type { Paging } from "./envelope";

/* ------------------------------------------------------------- filters */

export interface SessionFilters {
  status: SessionStatus[] | null;
  isAbstract: boolean | null;
  /** Track id OR track name — integrations rarely know our uuids. */
  track: string | null;
  room: string | null;
  text: string | null;
  createdBefore: number | null;
  createdAfter: number | null;
  updatedBefore: number | null;
  updatedAfter: number | null;
  includeDeleted: boolean;
}

export interface SessionSort {
  order: "createdAt" | "updatedAt" | "startsAt" | "title";
  direction: "asc" | "desc";
}

const EMPTY_FILTERS: SessionFilters = {
  status: null,
  isAbstract: null,
  track: null,
  room: null,
  text: null,
  createdBefore: null,
  createdAfter: null,
  updatedBefore: null,
  updatedAfter: null,
  includeDeleted: false,
};

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Normalize a filter body. PURE, and deliberately forgiving about case:
 * Sessionboard's own spec is inconsistent (`pageSize` next to `page_size`,
 * `isAbstract` next to `is_abstract` — §1 "Case convention"), so both spellings
 * are accepted rather than making an integration guess which one this endpoint
 * inherited.
 */
export function normalizeSessionFilters(raw: unknown): SessionFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_FILTERS };
  const input = raw as Record<string, unknown>;

  const statusRaw = pick(input, "status", "statuses");
  const statusList = (Array.isArray(statusRaw) ? statusRaw : statusRaw ? [statusRaw] : [])
    .map((value) => String(value))
    .filter((value): value is SessionStatus =>
      (SESSION_STATUSES as readonly string[]).includes(value),
    );

  const createdAt = (pick(input, "createdAt", "created_at") ?? {}) as Record<string, unknown>;
  const updatedAt = (pick(input, "updatedAt", "updated_at") ?? {}) as Record<string, unknown>;

  const track = pick(input, "track", "trackId", "track_id");
  const room = pick(input, "room", "roomId", "room_id");
  const text = pick(input, "text", "q", "search");

  return {
    status: statusList.length ? statusList : null,
    isAbstract: asBoolean(pick(input, "isAbstract", "is_abstract")),
    track: track ? String(track) : null,
    room: room ? String(room) : null,
    text: text ? String(text).trim() || null : null,
    createdBefore: asTimestamp(createdAt.before),
    createdAfter: asTimestamp(createdAt.after),
    updatedBefore: asTimestamp(updatedAt.before),
    updatedAfter: asTimestamp(updatedAt.after),
    includeDeleted: asBoolean(pick(input, "includeDeleted", "include_deleted")) === true,
  };
}

/**
 * Sort spec. Sessionboard allows `createdAt`/`updatedAt` only — you cannot sort
 * their sessions by start time or title (§8.5). We accept those two plus
 * `startsAt` and `title`: a strict superset, so every compatible client still
 * works, and the agenda is actually sortable.
 */
export function normalizeSessionSort(raw: unknown): SessionSort {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const orderRaw = String(pick(input, "order", "field", "by") ?? "updatedAt");
  const dirRaw = String(pick(input, "sort", "direction", "dir") ?? "desc").toLowerCase();

  const order: SessionSort["order"] =
    orderRaw === "createdAt" || orderRaw === "created_at"
      ? "createdAt"
      : orderRaw === "startsAt" || orderRaw === "starts_at"
        ? "startsAt"
        : orderRaw === "title"
          ? "title"
          : "updatedAt";

  return { order, direction: dirRaw === "asc" ? "asc" : "desc" };
}

/* --------------------------------------------------------------- query */

/** Escape LIKE wildcards so a title search for "100%" is not a match-everything. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function whereClause(eventId: string, filters: SessionFilters) {
  const clauses = [eq(sessions.eventId, eventId)];

  if (!filters.includeDeleted) clauses.push(isNull(sessions.deletedAt));
  if (filters.status) clauses.push(inArray(sessions.status, filters.status));
  if (filters.isAbstract !== null) clauses.push(eq(sessions.isAbstract, filters.isAbstract));
  if (filters.track) {
    clauses.push(
      or(eq(sessions.trackId, filters.track), eq(tracks.name, filters.track))!,
    );
  }
  if (filters.room) {
    clauses.push(or(eq(sessions.roomId, filters.room), eq(rooms.name, filters.room))!);
  }
  if (filters.text) {
    const pattern = likePattern(filters.text);
    clauses.push(
      or(
        sql`${sessions.title} like ${pattern} escape '\\'`,
        sql`coalesce(${sessions.description}, '') like ${pattern} escape '\\'`,
      )!,
    );
  }
  if (filters.createdBefore !== null) clauses.push(sql`${sessions.createdAt} < ${filters.createdBefore}`);
  if (filters.createdAfter !== null) clauses.push(sql`${sessions.createdAt} > ${filters.createdAfter}`);
  if (filters.updatedBefore !== null) clauses.push(sql`${sessions.updatedAt} < ${filters.updatedBefore}`);
  if (filters.updatedAfter !== null) clauses.push(sql`${sessions.updatedAt} > ${filters.updatedAfter}`);

  return and(...clauses);
}

/**
 * Aliased projection. Every output key is unique — that is what keeps the join
 * safe (see the file header) and what lets `serializeSession` stay pure.
 *
 * Embedded metadata carries no timestamps: hydrating four families' created_at
 * and updated_at costs eight more aliases per row for data nobody paginates on.
 * The dedicated `/v1/event/{id}/{family}` endpoints return them in full.
 */
const SESSION_PROJECTION = {
  id: sessions.id,
  eventId: sessions.eventId,
  friendlyId: sessions.friendlyId,
  title: sessions.title,
  description: sessions.description,
  status: sessions.status,
  isAbstract: sessions.isAbstract,
  formId: sessions.formId,
  answers: sessions.answers,
  videoUrl: sessions.videoUrl,
  externalUrl: sessions.externalUrl,
  startsAt: sessions.startsAt,
  endsAt: sessions.endsAt,
  capacity: sessions.capacity,
  isPublic: sessions.isPublic,
  publishedAt: sessions.publishedAt,
  composedIntoSessionId: sessions.composedIntoSessionId,
  deletedAt: sessions.deletedAt,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
  trackId: sessions.trackId,
  trackName: tracks.name,
  trackColor: tracks.color,
  trackOrder: tracks.order,
  roomId: sessions.roomId,
  roomName: rooms.name,
  roomCapacity: rooms.capacity,
  roomOrder: rooms.order,
  formatId: sessions.formatId,
  formatName: formats.name,
  formatMinutes: formats.defaultMinutes,
  formatOrder: formats.order,
  levelId: sessions.levelId,
  levelName: levels.name,
  levelOrder: levels.order,
} as const;

type SessionRow = {
  [K in keyof typeof SESSION_PROJECTION]: (typeof SESSION_PROJECTION)[K]["_"]["data"];
};

function orderBy(sort: SessionSort) {
  const direction = sort.direction === "asc" ? asc : desc;
  switch (sort.order) {
    case "createdAt":
      return [direction(sessions.createdAt), asc(sessions.id)];
    case "startsAt":
      return [direction(sessions.startsAt), asc(sessions.id)];
    case "title":
      return [direction(sessions.title), asc(sessions.id)];
    default:
      return [direction(sessions.updatedAt), asc(sessions.id)];
  }
}

/** Hydrate joined rows into the serializer's input shape. */
async function hydrate(rows: SessionRow[]): Promise<SessionInput[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((row) => row.id);

  const [participantRows, tagRows, sourceRows, targetRows] = await Promise.all([
    db
      .select({
        sessionId: sessionParticipants.sessionId,
        role: sessionParticipants.role,
        isPrimary: sessionParticipants.isPrimary,
        order: sessionParticipants.order,
        personId: people.id,
        email: people.email,
        fullName: people.fullName,
        firstName: people.firstName,
        lastName: people.lastName,
        pronouns: people.pronouns,
        company: people.company,
        personTitle: people.title,
        bio: people.bio,
        headshotKey: people.headshotKey,
        links: people.links,
        personCreatedAt: people.createdAt,
        personUpdatedAt: people.updatedAt,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(inArray(sessionParticipants.sessionId, ids))
      .orderBy(asc(sessionParticipants.order)),
    db
      .select({
        sessionId: sessionTags.sessionId,
        id: tags.id,
        name: tags.name,
        order: tags.order,
      })
      .from(sessionTags)
      .innerJoin(tags, eq(tags.id, sessionTags.tagId))
      .where(inArray(sessionTags.sessionId, ids))
      .orderBy(asc(tags.order), asc(tags.name)),
    // How many rows are composed INTO each row on this page — the `target`
    // side of composition_status. One grouped query, not one per row.
    db
      .select({
        targetId: sessions.composedIntoSessionId,
        n: count(),
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.composedIntoSessionId, ids),
          isNull(sessions.deletedAt),
        ),
      )
      .groupBy(sessions.composedIntoSessionId),
    // The rows THIS page is composed into — the `source` side.
    (() => {
      const targets = rows
        .map((row) => row.composedIntoSessionId)
        .filter((value): value is string => Boolean(value));
      if (targets.length === 0) {
        return Promise.resolve(
          [] as { id: string; friendlyId: string | null; title: string; isAbstract: boolean }[],
        );
      }
      return db
        .select({
          id: sessions.id,
          friendlyId: sessions.friendlyId,
          title: sessions.title,
          isAbstract: sessions.isAbstract,
        })
        .from(sessions)
        .where(inArray(sessions.id, targets));
    })(),
  ]);

  const participantsBySession = new Map<string, ParticipantInput[]>();
  for (const row of participantRows) {
    const list = participantsBySession.get(row.sessionId) ?? [];
    list.push({
      id: row.personId,
      email: row.email,
      fullName: row.fullName,
      firstName: row.firstName,
      lastName: row.lastName,
      pronouns: row.pronouns,
      company: row.company,
      title: row.personTitle,
      bio: row.bio,
      headshotKey: row.headshotKey,
      links: row.links,
      createdAt: row.personCreatedAt,
      updatedAt: row.personUpdatedAt,
      role: row.role,
      isPrimary: row.isPrimary,
      order: row.order,
    });
    participantsBySession.set(row.sessionId, list);
  }

  const tagsBySession = new Map<string, { id: string; name: string; order: number }[]>();
  for (const row of tagRows) {
    const list = tagsBySession.get(row.sessionId) ?? [];
    list.push({ id: row.id, name: row.name, order: row.order });
    tagsBySession.set(row.sessionId, list);
  }

  const sourceCounts = new Map<string, number>();
  for (const row of sourceRows) {
    if (row.targetId) sourceCounts.set(row.targetId, Number(row.n));
  }

  const targets = new Map<string, CompositionTargetInput>();
  for (const row of targetRows) targets.set(row.id, row);

  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    friendlyId: row.friendlyId,
    title: row.title,
    description: row.description,
    status: row.status,
    isAbstract: row.isAbstract,
    formId: row.formId,
    answers: row.answers,
    videoUrl: row.videoUrl,
    externalUrl: row.externalUrl,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacity,
    isPublic: row.isPublic,
    publishedAt: row.publishedAt,
    composedIntoSessionId: row.composedIntoSessionId,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    track: row.trackId
      ? {
          id: row.trackId,
          name: row.trackName ?? "",
          order: row.trackOrder ?? 0,
          color: row.trackColor ?? null,
        }
      : null,
    room: row.roomId
      ? {
          id: row.roomId,
          name: row.roomName ?? "",
          order: row.roomOrder ?? 0,
          capacity: row.roomCapacity ?? null,
        }
      : null,
    format: row.formatId
      ? {
          id: row.formatId,
          name: row.formatName ?? "",
          order: row.formatOrder ?? 0,
          defaultMinutes: row.formatMinutes ?? null,
        }
      : null,
    level: row.levelId
      ? { id: row.levelId, name: row.levelName ?? "", order: row.levelOrder ?? 0 }
      : null,
    participants: participantsBySession.get(row.id) ?? [],
    tags: tagsBySession.get(row.id) ?? [],
    sourceCount: sourceCounts.get(row.id) ?? 0,
    composedInto: row.composedIntoSessionId
      ? (targets.get(row.composedIntoSessionId) ?? null)
      : null,
  }));
}

export interface SessionSearchResult {
  sessions: SessionInput[];
  total: number;
}

export async function searchSessions(
  eventId: string,
  filters: SessionFilters,
  sort: SessionSort,
  paging: Paging,
): Promise<SessionSearchResult> {
  const db = getDb();
  const where = whereClause(eventId, filters);

  const [rows, totals] = await Promise.all([
    db
      .select(SESSION_PROJECTION)
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .leftJoin(formats, eq(formats.id, sessions.formatId))
      .leftJoin(levels, eq(levels.id, sessions.levelId))
      .where(where)
      .orderBy(...orderBy(sort))
      .limit(paging.pageSize)
      .offset(paging.offset),
    db
      .select({ n: count() })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(where),
  ]);

  return { sessions: await hydrate(rows as SessionRow[]), total: Number(totals[0]?.n ?? 0) };
}

export async function getSession(
  eventId: string,
  sessionId: string,
): Promise<SessionInput | null> {
  const rows = await getDb()
    .select(SESSION_PROJECTION)
    .from(sessions)
    .leftJoin(tracks, eq(tracks.id, sessions.trackId))
    .leftJoin(rooms, eq(rooms.id, sessions.roomId))
    .leftJoin(formats, eq(formats.id, sessions.formatId))
    .leftJoin(levels, eq(levels.id, sessions.levelId))
    .where(and(eq(sessions.eventId, eventId), eq(sessions.id, sessionId)))
    .limit(1);

  const hydrated = await hydrate(rows as SessionRow[]);
  return hydrated[0] ?? null;
}

/* ---------------------------------------------------------- validation */

export interface SessionWriteValues {
  title?: string;
  description?: string | null;
  status?: SessionStatus;
  isAbstract?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  capacity?: number | null;
  isPublic?: boolean;
  videoUrl?: string | null;
  externalUrl?: string | null;
  trackId?: string | null;
  roomId?: string | null;
  formatId?: string | null;
  levelId?: string | null;
  answers?: Record<string, unknown> | null;
}

export type ParseResult =
  | {
      ok: true;
      values: SessionWriteValues;
      expectedUpdatedAt: number | null;
      publishOverride: boolean;
      publishForce: boolean;
      publishOverrideReason: string | null;
      publishForceReason: string | null;
    }
  | { ok: false; message: string };

const MAX_TITLE = 300;

/**
 * The reserved namespace inside `sessions.answers`.
 *
 * `serialize.ts` already drops every `__`-prefixed key on the way OUT: they are
 * the product's own slots in the same blob — the wizard's `__content`
 * scaffolding, the eligible-track choice, and the on-behalf-of `__capture`
 * provenance that `admin.submission.tsx` renders as "Captured on the speaker's
 * behalf by X". A registry key can never start with `__`, because
 * `admin.forms.edit` strips leading underscores when it mints one.
 *
 * The write side had no equivalent, which made that display copy forgeable and
 * the provenance destructible. Both halves are needed and neither is sufficient:
 *
 *  - **strip on the way in** — an API caller cannot mint `__capture` naming any
 *    organizer they like. Reserved means reserved in both directions.
 *  - **merge on update** — `updateSession` replaces `answers` wholesale, so the
 *    obvious integration loop (GET, edit `custom_fields`, PUT) silently erased
 *    every reserved key, because the GET never showed them. Provenance is not
 *    the API's to delete, so the existing reserved keys survive the write.
 *
 * Requires an admin-minted, event-scoped key, so this was never a public hole.
 */
const RESERVED_ANSWER_PREFIX = "__";

const isReservedAnswerKey = (key: string): boolean => key.startsWith(RESERVED_ANSWER_PREFIX);

/** Everything a client is allowed to write — the reserved slots removed. */
export function stripReservedAnswers(
  answers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).filter(([key]) => !isReservedAnswerKey(key)),
  );
}

/**
 * Put the stored reserved keys back on top of a client-supplied blob.
 *
 * Nullable only because the patch slot is: `pick` treats an explicit
 * `answers: null` as absent, so a caller cannot reach here with one.
 */
export function mergeReservedAnswers(
  incoming: Record<string, unknown> | null | undefined,
  existing: unknown,
): Record<string, unknown> | null {
  const reserved =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? Object.entries(existing as Record<string, unknown>).filter(([key]) =>
          isReservedAnswerKey(key),
        )
      : [];
  if (reserved.length === 0) return incoming ?? null;
  return { ...(incoming ?? {}), ...Object.fromEntries(reserved) };
}

/**
 * Validate a create/update body. PURE — no DB, so every branch is unit-testable
 * without a fixture.
 *
 * `is_abstract` is accepted on CREATE and rejected on UPDATE: an abstract never
 * becomes a session, it gets composed into one (DECISIONS #3 / their §8.7). A
 * silent ignore would let an integration believe it had flipped the flag.
 */
export function parseSessionBody(raw: unknown, mode: "create" | "update"): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;
  const values: SessionWriteValues = {};

  const title = pick(input, "title");
  if (title !== undefined) {
    const text = String(title).trim();
    if (!text) return { ok: false, message: "`title` cannot be empty." };
    if (text.length > MAX_TITLE) {
      return { ok: false, message: `\`title\` is limited to ${MAX_TITLE} characters.` };
    }
    values.title = text;
  } else if (mode === "create") {
    return { ok: false, message: "`title` is required." };
  }

  if ("description" in input) {
    values.description = input.description === null ? null : String(input.description);
  }

  const status = pick(input, "status");
  if (status !== undefined) {
    const text = String(status);
    if (!(SESSION_STATUSES as readonly string[]).includes(text)) {
      return {
        ok: false,
        message: `\`status\` must be one of: ${SESSION_STATUSES.join(", ")}.`,
      };
    }
    values.status = text as SessionStatus;
  }

  const isAbstract = pick(input, "isAbstract", "is_abstract");
  if (isAbstract !== undefined) {
    if (mode === "update") {
      return {
        ok: false,
        message:
          "`is_abstract` is immutable after create. Link the abstract into a session instead.",
      };
    }
    const parsed = asBoolean(isAbstract);
    if (parsed === null) return { ok: false, message: "`is_abstract` must be a boolean." };
    values.isAbstract = parsed;
  }

  for (const [key, aliases] of [
    ["startsAt", ["startsAt", "starts_at"]],
    ["endsAt", ["endsAt", "ends_at"]],
  ] as const) {
    const present = aliases.some((alias) => alias in input);
    if (!present) continue;
    const value = pick(input, ...aliases);
    if (value === undefined) {
      values[key] = null;
      continue;
    }
    const parsed = asTimestamp(value);
    if (parsed === null) {
      return { ok: false, message: `\`${aliases[1]}\` must be an ISO-8601 timestamp or null.` };
    }
    values[key] = new Date(parsed);
  }

  if (
    values.startsAt instanceof Date &&
    values.endsAt instanceof Date &&
    values.endsAt.getTime() <= values.startsAt.getTime()
  ) {
    return { ok: false, message: "`ends_at` must be after `starts_at`." };
  }

  if ("capacity" in input) {
    if (input.capacity === null) {
      values.capacity = null;
    } else {
      const n = Number(input.capacity);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return { ok: false, message: "`capacity` must be a non-negative integer or null." };
      }
      values.capacity = n;
    }
  }

  if (mode === "create" && ("isPublic" in input || "is_public" in input)) {
    return {
      ok: false,
      message:
        "`is_public` is not accepted on create. Create the session, then publish it once its speaker has been told.",
    };
  }
  const isPublic = pick(input, "isPublic", "is_public");
  if (isPublic !== undefined) {
    const parsed = asBoolean(isPublic);
    if (parsed === null) return { ok: false, message: "`is_public` must be a boolean." };
    values.isPublic = parsed;
  }

  for (const [key, aliases] of [
    ["videoUrl", ["videoUrl", "video_url"]],
    ["externalUrl", ["externalUrl", "external_url"]],
    ["trackId", ["trackId", "track_id"]],
    ["roomId", ["roomId", "room_id"]],
    ["formatId", ["formatId", "format_id"]],
    ["levelId", ["levelId", "level_id"]],
  ] as const) {
    if (!aliases.some((alias) => alias in input)) continue;
    const value = pick(input, ...aliases);
    values[key] = value === undefined ? null : String(value);
  }

  const answers = pick(input, "answers", "custom_fields", "customFields");
  if (answers !== undefined) {
    if (Array.isArray(answers)) {
      // Accept Sessionboard's `custom_fields: [{key, value}]` array and store it
      // as the flat answers map the rest of the product reads.
      const map: Record<string, unknown> = {};
      for (const entry of answers) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.key !== "string") continue;
        map[item.key] = item.value ?? null;
      }
      // Silently, not as a 400: a client round-tripping a body it did not
      // author should not be rejected for a key it never saw. The read side
      // already hides these, so a caller cannot know to omit them.
      values.answers = stripReservedAnswers(map);
    } else if (typeof answers === "object") {
      values.answers = stripReservedAnswers(answers as Record<string, unknown>);
    } else {
      return { ok: false, message: "`answers` must be an object or a custom_fields array." };
    }
  }

  const expected = asTimestamp(pick(input, "updatedAt", "updated_at"));
  const publishOverrideRaw = pick(input, "publishOverride", "publish_override");
  if (mode === "create" && ("publishOverride" in input || "publish_override" in input)) {
    return { ok: false, message: "`publish_override` is accepted only on update." };
  }
  const publishOverride = publishOverrideRaw === undefined
    ? false
    : asBoolean(publishOverrideRaw);
  if (publishOverride === null) {
    return { ok: false, message: "`publish_override` must be a boolean." };
  }
  const publishOverrideReasonRaw = pick(
    input,
    "publishOverrideReason",
    "publish_override_reason",
  );
  const publishOverrideReason = publishOverrideReasonRaw === undefined
    ? null
    : String(publishOverrideReasonRaw).trim() || null;
  if (publishOverride && !publishOverrideReason) {
    return {
      ok: false,
      message: "`publish_override_reason` is required when `publish_override` is true.",
    };
  }
  const publishForceRaw = pick(input, "publishForce", "publish_force");
  if (mode === "create" && ("publishForce" in input || "publish_force" in input)) {
    return { ok: false, message: "`publish_force` is accepted only on update." };
  }
  const publishForce = publishForceRaw === undefined
    ? false
    : asBoolean(publishForceRaw);
  if (publishForce === null) {
    return { ok: false, message: "`publish_force` must be a boolean." };
  }
  const publishForceReasonRaw = pick(input, "publishForceReason", "publish_force_reason");
  const publishForceReason = publishForceReasonRaw === undefined
    ? null
    : String(publishForceReasonRaw).trim() || null;
  if (publishForce && !publishForceReason) {
    return {
      ok: false,
      message: "`publish_force_reason` is required when `publish_force` is true.",
    };
  }

  return {
    ok: true,
    values,
    expectedUpdatedAt: mode === "update" ? expected : null,
    publishOverride,
    publishForce,
    publishOverrideReason,
    publishForceReason,
  };
}

/* ----------------------------------------------------------- mutations */

export type WriteError =
  | { code: "not_found"; message: string }
  | { code: "conflict"; message: string }
  | { code: "validation"; message: string };

export type WriteResult<T> = { ok: true; value: T } | { ok: false; error: WriteError };

/**
 * `ABS-3` / `SESS-12`. Sessionboard puts a human-readable short id on every
 * record and integrations lean on it; a null here would make API-created rows
 * the only ones without one. Uniqueness is a DB constraint, so a collision
 * (two concurrent creates counting the same number) falls back to no id rather
 * than failing the whole create.
 */
async function nextFriendlyId(eventId: string, isAbstract: boolean): Promise<string | null> {
  const prefix = isAbstract ? "ABS" : "SESS";
  const [row] = await getDb()
    .select({ n: count() })
    .from(sessions)
    .where(and(eq(sessions.eventId, eventId), eq(sessions.isAbstract, isAbstract)));
  return `${prefix}-${Number(row?.n ?? 0) + 1}`;
}

export async function createSession(
  eventId: string,
  values: SessionWriteValues,
): Promise<WriteResult<SessionInput>> {
  const db = getDb();
  const isAbstract = values.isAbstract ?? false;
  const friendlyId = await nextFriendlyId(eventId, isAbstract);

  const row = {
    eventId,
    title: values.title!,
    description: values.description ?? null,
    status: values.status ?? (isAbstract ? ("pending" as const) : ("draft" as const)),
    isAbstract,
    answers: values.answers ?? null,
    videoUrl: values.videoUrl ?? null,
    externalUrl: values.externalUrl ?? null,
    trackId: values.trackId ?? null,
    roomId: values.roomId ?? null,
    formatId: values.formatId ?? null,
    levelId: values.levelId ?? null,
    startsAt: values.startsAt ?? null,
    endsAt: values.endsAt ?? null,
    capacity: values.capacity ?? null,
    isPublic: values.isPublic ?? false,
  };

  let created: { id: string } | undefined;
  try {
    [created] = await db.insert(sessions).values({ ...row, friendlyId }).returning({
      id: sessions.id,
    });
  } catch {
    // Almost always the (event_id, friendly_id) unique index losing a race, or a
    // metadata FK pointing at another event's row. Retry once without the
    // generated id; a genuine FK problem still surfaces below.
    try {
      [created] = await db.insert(sessions).values(row).returning({ id: sessions.id });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: `Create failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  if (!created) {
    return { ok: false, error: { code: "validation", message: "Create failed." } };
  }
  const hydrated = await getSession(eventId, created.id);
  if (hydrated) {
    await emitWebhook("session.created", created.id, { eventId, session: hydrated });
  }
  return hydrated
    ? { ok: true, value: hydrated }
    : { ok: false, error: { code: "not_found", message: "Created row vanished." } };
}

export async function updateSession(
  eventId: string,
  sessionId: string,
  values: SessionWriteValues,
  expectedUpdatedAt: number | null,
  options: {
    publishOverride?: boolean;
    publishForce?: boolean;
    publishOverrideReason?: string | null;
    publishForceReason?: string | null;
    actor: GateOverrideActor;
  },
): Promise<WriteResult<SessionInput>> {
  const db = getDb();
  const existing = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), eq(sessions.eventId, eventId)),
  });
  if (!existing || existing.deletedAt) {
    return { ok: false, error: { code: "not_found", message: "Session not found." } };
  }

  /*
   * Optimistic concurrency, Sessionboard-style (§1): send the `updated_at` you
   * read, get a 409 if someone else wrote in between.
   *
   * MILLISECOND precision, not second. Truncating to seconds was the first
   * implementation and it silently disabled the guard for any two writes inside
   * the same second — the exact window where a race actually happens (the e2e
   * caught it: create → update → stale-update all landed in one second and the
   * stale write returned 200). The failure mode of strictness is a client that
   * reformats the timestamp getting a loud, reproducible 409; the failure mode
   * of leniency is a lost update nobody sees.
   */
  if (expectedUpdatedAt !== null && expectedUpdatedAt !== existing.updatedAt.getTime()) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message: `Stale \`updated_at\`. The session was last modified at ${existing.updatedAt.toISOString()}.`,
      },
    };
  }

  const isPublishing = values.isPublic === true && !existing.isPublic;
  const publishOverride = options.publishOverride ?? false;
  const publishForce = options.publishForce ?? false;
  // Explicit nulls are writes, not omissions. Resolve the proposed row with an
  // undefined check so clearing a placement cannot borrow the stored value and
  // pass a pre-write gate for a state that will not exist after the update.
  const finalStartsAt = values.startsAt === undefined ? existing.startsAt : values.startsAt;
  const finalEndsAt = values.endsAt === undefined ? existing.endsAt : values.endsAt;
  const finalRoomId = values.roomId === undefined ? existing.roomId : values.roomId;

  if (isPublishing && !finalStartsAt) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Give the session a time before publishing it.",
      },
    };
  }

  const informedWouldBlock = isPublishing && !(await isSessionInformed(db, sessionId));
  if (informedWouldBlock && !publishOverride) {
    return {
      ok: false,
      error: {
        code: "conflict",
        message:
          "The speaker hasn't been told about this session yet. Send their decision letter, or pass `publish_override: true`.",
      },
    };
  }
  const publishOverrideApplied = informedWouldBlock && publishOverride;
  const publishOverrideReason = options.publishOverrideReason?.trim() || null;
  if (publishOverrideApplied && !publishOverrideReason) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "`publish_override_reason` is required when the informed gate is overridden.",
      },
    };
  }

  let publishForceApplied = false;
  if (isPublishing && finalStartsAt && finalEndsAt) {
    const programme = await loadProgramme(eventId);
    const roomName = finalRoomId
      ? programme.rooms.find((room) => room.id === finalRoomId)?.name ?? null
      : null;
    const conflicts = blockingConflicts(
      predictConflicts(programme.sessions, {
        sessionId,
        roomId: finalRoomId,
        roomName,
        startsAt: finalStartsAt.getTime(),
        endsAt: finalEndsAt.getTime(),
      }),
    );
    if (conflicts.length > 0 && !publishForce) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `Publishing would create: ${conflicts.map(conflictLabel).join("; ")}. Resolve the conflict, or pass \`publish_force: true\`.`,
        },
      };
    }
    publishForceApplied = conflicts.length > 0 && publishForce;
  }
  const publishForceReason = options.publishForceReason?.trim() || null;
  if (publishForceApplied && !publishForceReason) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "`publish_force_reason` is required when the conflict gate is forced.",
      },
    };
  }

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "isAbstract") continue;
    if (value !== undefined) patch[key] = value;
  }
  /*
   * `answers` is replaced wholesale, and the read side never showed the
   * reserved keys, so the natural integration loop — GET, edit
   * `custom_fields`, PUT — deleted the provenance block the organizer's UI
   * reads. Restore it from the row being written. Only reached when the caller
   * actually sent `answers`; a PUT that leaves it out never touches the blob.
   */
  if ("answers" in patch) {
    patch.answers = mergeReservedAnswers(
      patch.answers as Record<string, unknown> | null,
      existing.answers,
    );
  }
  if (Object.keys(patch).length === 0) {
    const unchanged = await getSession(eventId, sessionId);
    return unchanged
      ? { ok: true, value: unchanged }
      : { ok: false, error: { code: "not_found", message: "Session not found." } };
  }

  try {
    await db
      .update(sessions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.eventId, eventId)));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: `Update failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (publishOverrideApplied && publishOverrideReason) {
    await recordGateOverride({
      eventId,
      sessionId,
      kind: "publish_override",
      reason: publishOverrideReason,
      actor: options.actor,
    });
  }
  if (publishForceApplied && publishForceReason) {
    await recordGateOverride({
      eventId,
      sessionId,
      kind: "publish_force",
      reason: publishForceReason,
      actor: options.actor,
    });
  }

  const updated = await getSession(eventId, sessionId);
  if (updated) {
    const event = values.isPublic === true && !existing.isPublic
      ? "session.published"
      : "session.updated";
    await emitWebhook(event, sessionId, { eventId, session: updated });
  }
  return updated
    ? { ok: true, value: updated }
    : { ok: false, error: { code: "not_found", message: "Session not found." } };
}

/** Soft delete. The row stays, `deleted_at` is set, `/restore` puts it back. */
export async function softDeleteSession(
  eventId: string,
  sessionId: string,
): Promise<WriteResult<{ id: string; deleted_at: string }>> {
  const now = new Date();
  const rows = await getDb()
    .update(sessions)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.eventId, eventId),
        isNull(sessions.deletedAt),
      ),
    )
    .returning({ id: sessions.id });

  if (rows.length === 0) {
    return {
      ok: false,
      error: { code: "not_found", message: "Session not found, or already deleted." },
    };
  }
  await emitWebhook("session.deleted", rows[0].id, { eventId, deletedAt: now.toISOString() });
  return { ok: true, value: { id: rows[0].id, deleted_at: now.toISOString() } };
}

export async function restoreSession(
  eventId: string,
  sessionId: string,
): Promise<WriteResult<SessionInput>> {
  const rows = await getDb()
    .update(sessions)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.eventId, eventId),
        isNotNull(sessions.deletedAt),
      ),
    )
    .returning({ id: sessions.id });

  if (rows.length === 0) {
    return {
      ok: false,
      error: { code: "not_found", message: "Session not found, or not deleted." },
    };
  }
  const restored = await getSession(eventId, sessionId);
  return restored
    ? { ok: true, value: restored }
    : { ok: false, error: { code: "not_found", message: "Session not found." } };
}

/* ---------------------------------------------------------------- bulk */

export const MAX_BULK_OPERATIONS = 100;

export interface BulkItemResult {
  index: number;
  action: string;
  status: "success" | "error";
  id?: string;
  error?: { code: string; message: string };
}

export interface BulkResponse {
  batch_id: string;
  results: BulkItemResult[];
  stats: { total: number; succeeded: number; failed: number };
}

/**
 * Partial-success bulk, matching their response shape (§3 "Bulk operations").
 *
 * Sequential on purpose: D1 has no interactive transactions, so "all or
 * nothing" is not on the menu anyway, and running 100 writes concurrently
 * against one D1 binding is how you find its connection limits during a demo.
 * Every item reports its own outcome; one bad row never sinks the batch.
 */
export async function bulkSessions(
  eventId: string,
  operations: unknown,
  actor: GateOverrideActor,
): Promise<{ ok: true; value: BulkResponse } | { ok: false; message: string }> {
  if (!Array.isArray(operations)) {
    return { ok: false, message: "`operations` must be an array." };
  }
  if (operations.length === 0) {
    return { ok: false, message: "`operations` cannot be empty." };
  }
  if (operations.length > MAX_BULK_OPERATIONS) {
    return {
      ok: false,
      message: `A bulk request is limited to ${MAX_BULK_OPERATIONS} operations; got ${operations.length}.`,
    };
  }

  const results: BulkItemResult[] = [];

  for (const [index, raw] of operations.entries()) {
    const operation = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const action = String(operation.action ?? "");
    const id = operation.id === undefined ? null : String(operation.id);
    const data = operation.data;

    const fail = (code: string, message: string) =>
      results.push({ index, action: action || "unknown", status: "error", error: { code, message } });

    if (action === "create") {
      const parsed = parseSessionBody(data, "create");
      if (!parsed.ok) {
        fail("validation", parsed.message);
        continue;
      }
      const created = await createSession(eventId, parsed.values);
      if (created.ok) {
        results.push({ index, action, status: "success", id: created.value.id });
      } else {
        fail(created.error.code, created.error.message);
      }
    } else if (action === "update") {
      if (!id) {
        fail("validation", "`id` is required for an update operation.");
        continue;
      }
      const parsed = parseSessionBody(data, "update");
      if (!parsed.ok) {
        fail("validation", parsed.message);
        continue;
      }
      const updated = await updateSession(
        eventId,
        id,
        parsed.values,
        parsed.expectedUpdatedAt,
        {
          publishOverride: parsed.publishOverride,
          publishForce: parsed.publishForce,
          publishOverrideReason: parsed.publishOverrideReason,
          publishForceReason: parsed.publishForceReason,
          actor,
        },
      );
      if (updated.ok) {
        results.push({ index, action, status: "success", id: updated.value.id });
      } else {
        fail(updated.error.code, updated.error.message);
      }
    } else if (action === "delete") {
      if (!id) {
        fail("validation", "`id` is required for a delete operation.");
        continue;
      }
      const deleted = await softDeleteSession(eventId, id);
      if (deleted.ok) {
        results.push({ index, action, status: "success", id: deleted.value.id });
      } else {
        fail(deleted.error.code, deleted.error.message);
      }
    } else {
      fail("validation", `Unknown action "${action}". Use create, update, or delete.`);
    }
  }

  const succeeded = results.filter((result) => result.status === "success").length;
  return {
    ok: true,
    value: {
      batch_id: crypto.randomUUID(),
      results,
      stats: {
        total: operations.length,
        succeeded,
        failed: operations.length - succeeded,
      },
    },
  };
}
