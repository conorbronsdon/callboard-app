/**
 * Pure recipient selection, validation, and per-speaker merge data for bulk mail.
 * Database loading and delivery live in bulk.server.ts.
 */
import { formatDue, formatTaskList, isOpenTaskStatus, type ReminderBatch } from "./reminders";
import { firstNameOf } from "./schedule-invite";
import { mergeContext, type MergeContext } from "./templates";

export const BULK_AUDIENCES = [
  { id: "all_speakers", label: "All speakers" },
  { id: "accepted", label: "Accepted speakers" },
  { id: "pending", label: "Pending decisions" },
  { id: "outstanding_tasks", label: "Has outstanding tasks" },
  { id: "track", label: "Speakers in a track" },
] as const;

export type BulkAudience = (typeof BULK_AUDIENCES)[number]["id"];

export function isBulkAudience(value: unknown): value is BulkAudience {
  return BULK_AUDIENCES.some((audience) => audience.id === value);
}

export const MAX_BULK_RECIPIENTS = 250;

/** FNV-1a over a string. Synchronous on purpose — usable inside SSR/browser
 * renders and cheap enough for a per-request server check, with no Web
 * Crypto dependency. Not a security boundary anywhere it is used. */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Stable fingerprint of a recipient set, independent of input order. This is a
 * UX staleness guard, not a security boundary.
 */
export function hashRecipientIds(ids: readonly string[]): string {
  return fnv1aHash([...ids].sort().join("\u0001"));
}

/**
 * Deterministic content fingerprint for a bulk send (issue #198) — the
 * fallback idempotency key `sendBulkComm` uses when a caller does not supply
 * one of its own (e.g. a direct test call, not the compose route's
 * per-render submit nonce). Two calls with identical substance collapse to
 * the same key, which is what lets a bare `Promise.all([sendBulkComm(a),
 * sendBulkComm(a)])` get deduplicated with no caller changes at all.
 * Recipient order does not matter; every other field does.
 */
export function hashBulkSendContent(input: {
  eventId: string;
  recipients: readonly string[];
  subject: string;
  body: string;
  audience: string;
}): string {
  const recipientsPart = [...input.recipients].sort().join("\u0001");
  return fnv1aHash(
    [input.eventId, input.audience, input.subject, input.body, recipientsPart].join("\u0001"),
  );
}

/**
 * Template key stamped on a free-form bulk send. Deliberately NOT a
 * `TemplateKey`: there is no `email_templates` row behind it, and
 * `reminders.server.ts` dedupes the cron off `templateKey = "task_reminder"`,
 * so a custom blast must never wear a key that suppresses a real reminder.
 */
export const BULK_CUSTOM_TEMPLATE_KEY = "bulk_custom";

export interface BulkSession {
  id: string;
  friendlyId?: string | null;
  title: string;
  status: string;
  trackId: string | null;
  startsAt: number | null;
  endsAt?: number | null;
  roomName: string | null;
  formName?: string | null;
  /** Used to choose the most recent session when none is accepted. */
  updatedAt?: number | null;
}

export interface BulkTask {
  id: string;
  title: string;
  dueAt: number | null;
  status: string;
}

export interface BulkRecipient {
  personId: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  eventRole: string;
  sessions: BulkSession[];
  openTasks: BulkTask[];
}

const UNDECIDED = new Set(["pending", "accept_queue", "draft"]);

/**
 * Pending intentionally requires at least one session. A roster-only speaker has
 * no decision waiting, so including them would make this filter misleading.
 */
export function selectRecipients(
  candidates: readonly BulkRecipient[],
  audience: BulkAudience,
  trackId?: string | null,
): BulkRecipient[] {
  const speakers = candidates.filter((candidate) => candidate.eventRole === "speaker");

  switch (audience) {
    case "all_speakers":
      return speakers;
    case "accepted":
      return speakers.filter((candidate) =>
        candidate.sessions.some((session) => session.status === "accepted"),
      );
    case "pending":
      return speakers.filter(
        (candidate) =>
          candidate.sessions.length > 0 &&
          candidate.sessions.every((session) => UNDECIDED.has(session.status)),
      );
    case "outstanding_tasks":
      return speakers.filter((candidate) =>
        candidate.openTasks.some((task) => isOpenTaskStatus(task.status)),
      );
    case "track": {
      if (!trackId?.trim()) return [];
      return speakers.filter((candidate) =>
        candidate.sessions.some((session) => session.trackId === trackId),
      );
    }
  }
}

/** Explicit copy used whenever source data cannot honestly fill a known token. */
export const MERGE_FALLBACKS = {
  "speaker.first_name": "there",
  "speaker.name": "speaker",
  "event.location": "the event",
  "session.title": "your session",
  "session.id": "not assigned",
  "session.time": "a time we will confirm",
  "session.room": "a room we will confirm",
  "form.name": "the submission form",
  "task.list": "no open tasks",
  "task.count": "0",
  "task.due": "no due date",
} as const;

export interface BulkEventContext {
  name: string;
  location?: string | null;
  timezone: string;
}

export interface RecipientContextOptions {
  origin: string;
  now?: number | Date;
}

function chosenSession(sessions: readonly BulkSession[]): BulkSession | null {
  const score = (session: BulkSession) => session.updatedAt ?? session.startsAt ?? 0;
  const newest = (rows: readonly BulkSession[]) =>
    [...rows].sort((a, b) => {
      // A scheduled accepted session is more useful than its source abstract.
      const scheduled = Number(Boolean(b.startsAt)) - Number(Boolean(a.startsAt));
      return scheduled || score(b) - score(a);
    })[0] ?? null;
  return newest(sessions.filter((session) => session.status === "accepted")) ?? newest(sessions);
}

function sessionTime(session: BulkSession, timeZone: string): string | null {
  if (session.startsAt === null || !Number.isFinite(session.startsAt)) return null;
  const start = new Date(session.startsAt);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(start);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const startLabel = time.format(start);
  const endLabel =
    session.endsAt !== null && session.endsAt !== undefined && Number.isFinite(session.endsAt)
      ? ` – ${time.format(new Date(session.endsAt))}`
      : "";
  return `${date} · ${startLabel}${endLabel}`;
}

function localPart(email: string): string {
  return email.split("@")[0]?.trim() || email;
}

function taskValues(
  recipient: BulkRecipient,
  event: BulkEventContext,
  now: number,
): { list: string | null; count: string; due: string | null; taskIds: string[] } {
  const tasks = recipient.openTasks.filter((task) => isOpenTaskStatus(task.status));
  if (tasks.length === 0) return { list: null, count: "0", due: null, taskIds: [] };

  const dated = tasks
    .filter((task): task is BulkTask & { dueAt: number } =>
      task.dueAt !== null && Number.isFinite(task.dueAt),
    )
    .sort((a, b) => a.dueAt - b.dueAt);
  const undated = tasks.filter((task) => task.dueAt === null || !Number.isFinite(task.dueAt));
  const batch: ReminderBatch = {
    personId: recipient.personId,
    email: recipient.email,
    name: recipient.fullName,
    tasks: dated.map((task) => ({
      taskId: task.id,
      personId: recipient.personId,
      email: recipient.email,
      name: recipient.fullName,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
    })),
    soonestDueAt: dated[0]?.dueAt ?? now,
    overdueCount: dated.filter((task) => task.dueAt < now).length,
  };
  const lines = [
    ...(dated.length ? [formatTaskList(batch, now, event.timezone)] : []),
    ...undated.map((task) => `- ${task.title} (no due date)`),
  ];
  return {
    list: lines.join("\n"),
    count: String(tasks.length),
    due: dated.length ? formatDue(dated[0].dueAt, event.timezone) : null,
    taskIds: tasks.map((task) => task.id),
  };
}

export interface BuiltRecipientContext {
  context: MergeContext;
  fallbacksUsed: string[];
  taskIds: string[];
}

/** Build every known merge value so no valid token silently disappears. */
export function buildRecipientContext(
  recipient: BulkRecipient,
  event: BulkEventContext,
  options: RecipientContextOptions,
): BuiltRecipientContext {
  const fallbacksUsed: string[] = [];
  const fallback = <K extends keyof typeof MERGE_FALLBACKS>(key: K): string => {
    fallbacksUsed.push(key);
    return MERGE_FALLBACKS[key];
  };
  const session = chosenSession(recipient.sessions);
  const now = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  const task = taskValues(recipient, event, now);
  const fullName = recipient.fullName?.trim() || null;
  const firstName =
    recipient.firstName?.trim() || firstNameOf(fullName) || localPart(recipient.email) || null;
  const location = event.location?.trim() || event.name.trim() || null;
  const time = session ? sessionTime(session, event.timezone) : null;

  return {
    context: mergeContext({
      "speaker.name": fullName || recipient.email || fallback("speaker.name"),
      "speaker.first_name": firstName || fallback("speaker.first_name"),
      "speaker.email": recipient.email,
      "event.name": event.name,
      "event.location": location || fallback("event.location"),
      "session.title": session?.title.trim() || fallback("session.title"),
      "session.id": session?.friendlyId?.trim() || fallback("session.id"),
      "session.time": time || fallback("session.time"),
      "session.room": session?.roomName?.trim() || fallback("session.room"),
      "form.name": session?.formName?.trim() || fallback("form.name"),
      "task.list": task.list || fallback("task.list"),
      "task.count": task.count === "0" ? fallback("task.count") : task.count,
      "task.due": task.due || fallback("task.due"),
      "portal.url": `${options.origin.replace(/\/$/, "")}/portal`,
    }),
    fallbacksUsed,
    taskIds: task.taskIds,
  };
}

export interface ComposeValidationInput {
  subject: string;
  body: string;
  recipientIds: readonly string[];
  audience: unknown;
  trackId?: string | null;
  validTrackIds?: readonly string[];
}

export type ComposeValidation = { ok: true; error: null } | { ok: false; error: string };

export function validateCompose(input: ComposeValidationInput): ComposeValidation {
  if (!isBulkAudience(input.audience)) {
    return { ok: false, error: "Choose a known recipient audience." };
  }
  if (input.audience === "track") {
    if (!input.trackId?.trim()) {
      return { ok: false, error: "Choose a track for the track audience." };
    }
    if (input.validTrackIds && !input.validTrackIds.includes(input.trackId)) {
      return { ok: false, error: "Choose a track that belongs to this event." };
    }
  }
  if (!input.subject.trim()) {
    return { ok: false, error: "A subject is required — an empty one reads as spam." };
  }
  if (!input.body.trim()) return { ok: false, error: "A body is required." };
  if (input.recipientIds.length === 0) {
    return { ok: false, error: "Select at least one recipient before sending." };
  }
  if (input.recipientIds.length > MAX_BULK_RECIPIENTS) {
    return {
      ok: false,
      error: `Select no more than ${MAX_BULK_RECIPIENTS} recipients at a time.`,
    };
  }
  return { ok: true, error: null };
}
