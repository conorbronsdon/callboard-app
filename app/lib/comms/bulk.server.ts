/** Database loading, preview, and comm-log-decorated delivery for bulk email. */
import { and, asc, eq, lt, notInArray } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import {
  commBatches,
  eventPeople,
  forms,
  people,
  rooms,
  sessionParticipants,
  sessions,
  tasks,
} from "~/db/schema";
import type { MailResult, Mailer } from "~/lib/mail/mailer";

import {
  BULK_CUSTOM_TEMPLATE_KEY,
  MAX_BULK_RECIPIENTS,
  buildRecipientContext,
  hashBulkSendContent,
  type BulkAudience,
  type BulkEventContext,
  type BulkRecipient,
} from "./bulk";
import { withCommLog } from "./comm-log.server";
import { renderEmail, unknownMergeFields } from "./templates";

/** Three set-based queries: roster, participant sessions, and open tasks. */
export async function loadComposeRecipients(options: {
  eventId: string;
  db?: DB;
}): Promise<BulkRecipient[]> {
  const db = options.db ?? getDb();
  const [roster, sessionRows, taskRows] = await Promise.all([
    db
      .select({
        personId: people.id,
        email: people.email,
        fullName: people.fullName,
        firstName: people.firstName,
        eventRole: eventPeople.eventRole,
      })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(eq(eventPeople.eventId, options.eventId))
      .orderBy(asc(people.email)),
    db
      .select({
        personId: sessionParticipants.personId,
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        status: sessions.status,
        trackId: sessions.trackId,
        startsAt: sessions.startsAt,
        endsAt: sessions.endsAt,
        roomName: rooms.name,
        formName: forms.name,
        updatedAt: sessions.updatedAt,
      })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .leftJoin(forms, eq(forms.id, sessions.formId))
      .where(eq(sessions.eventId, options.eventId))
      .orderBy(asc(sessions.createdAt)),
    db
      .select({
        personId: tasks.personId,
        id: tasks.id,
        title: tasks.title,
        dueAt: tasks.dueAt,
        status: tasks.status,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.eventId, options.eventId),
          notInArray(tasks.status, ["complete", "waived"]),
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.title)),
  ]);

  const byPerson = new Map<string, BulkRecipient>(
    roster.map((row) => [
      row.personId,
      {
        personId: row.personId,
        email: row.email,
        fullName: row.fullName,
        firstName: row.firstName,
        eventRole: row.eventRole,
        sessions: [],
        openTasks: [],
      },
    ]),
  );
  const seenSessions = new Set<string>();
  for (const row of sessionRows) {
    const recipient = byPerson.get(row.personId);
    const key = `${row.personId}:${row.id}`;
    if (!recipient || seenSessions.has(key)) continue;
    seenSessions.add(key);
    recipient.sessions.push({
      id: row.id,
      friendlyId: row.friendlyId,
      title: row.title,
      status: row.status,
      trackId: row.trackId,
      startsAt: row.startsAt ? row.startsAt.getTime() : null,
      endsAt: row.endsAt ? row.endsAt.getTime() : null,
      roomName: row.roomName,
      formName: row.formName,
      updatedAt: row.updatedAt ? row.updatedAt.getTime() : null,
    });
  }
  for (const row of taskRows) {
    byPerson.get(row.personId)?.openTasks.push({
      id: row.id,
      title: row.title,
      dueAt: row.dueAt ? row.dueAt.getTime() : null,
      status: row.status,
    });
  }
  return [...byPerson.values()];
}

export interface BulkPreview {
  subject: string;
  text: string;
  fallbacksUsed: string[];
  unknownFields: string[];
}

export function previewBulkComm(options: {
  recipient: BulkRecipient;
  event: BulkEventContext;
  subject: string;
  body: string;
  templateKey?: string | null;
  origin: string;
  now?: number | Date;
}): BulkPreview {
  const built = buildRecipientContext(options.recipient, options.event, {
    origin: options.origin,
    now: options.now,
  });
  const rendered = renderEmail(
    {
      key: (options.templateKey || BULK_CUSTOM_TEMPLATE_KEY) as never,
      subject: options.subject,
      body: options.body,
    },
    built.context,
  );
  return {
    ...rendered,
    fallbacksUsed: built.fallbacksUsed,
    unknownFields: unknownMergeFields(`${options.subject}\n${options.body}`),
  };
}

export interface BulkSendRow {
  email: string;
  ok: boolean;
  error?: string;
}

export interface BulkSendResult {
  attempted: number;
  sent: number;
  failed: number;
  rows: BulkSendRow[];
  error?: string;
}

/** Convert a thrown provider failure into MailResult so withCommLog records it. */
export function nonThrowing(mailer: Mailer): Mailer {
  return {
    name: mailer.name,
    // Forwarded, never asserted: wrapping the console mailer does not give it a
    // provider to hear back from, and wrapping Resend must not hide that it has one.
    observesDelivery: mailer.observesDelivery,
    async send(message): Promise<MailResult> {
      try {
        return await mailer.send(message);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Rolling dedup window for the idempotency claim below (issue #198). Long
 * enough to absorb a double-click or a client's automatic retry of a slow
 * POST; short enough that a genuine deliberate resend minutes later (an
 * organizer clicking "resend invite" again) is never blocked by it.
 */
const COMM_BATCH_DEDUP_WINDOW_MS = 30_000;

/**
 * True for the specific failure a UNIQUE index rejection produces — never a
 * generic DB-error catch-all, so an unrelated failure surfaces as itself
 * instead of being mislabeled "already sent". Drizzle wraps the driver's
 * error ("Failed query: insert into ...") with the real SQLite/D1 message
 * ("UNIQUE constraint failed: ...") on `.cause`, so this walks the cause
 * chain rather than checking `error.message` alone.
 */
function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) {
      if (/unique constraint/i.test(current.message)) return true;
      current = current.cause;
    } else {
      break;
    }
  }
  return false;
}

export async function sendBulkComm(options: {
  eventId: string;
  event: BulkEventContext;
  /** Posted person ids. They are resolved again here to enforce event scope. */
  recipients: readonly string[];
  subject: string;
  body: string;
  templateKey?: string | null;
  templateId?: string | null;
  audience: BulkAudience;
  origin: string;
  mailer: Mailer;
  db?: DB;
  now?: Date;
  /**
   * Caller-supplied dedup key (the compose route's per-render submit nonce).
   * When omitted, a deterministic hash of the send's own content stands in —
   * that fallback is what lets two directly-called `sendBulkComm(args)`
   * with identical args dedupe with no caller changes at all.
   */
  idempotencyKey?: string;
}): Promise<BulkSendResult> {
  const db = options.db ?? getDb();
  const recipientIds = [...new Set(options.recipients)];
  const rejected = (error: string): BulkSendResult => ({
    attempted: 0,
    sent: 0,
    failed: 0,
    rows: [],
    error,
  });
  if (recipientIds.length === 0) return rejected("Select at least one recipient before sending.");
  if (recipientIds.length > MAX_BULK_RECIPIENTS) {
    return rejected(`Select no more than ${MAX_BULK_RECIPIENTS} recipients at a time.`);
  }
  if (!options.subject.trim()) return rejected("A subject is required — an empty one reads as spam.");
  if (!options.body.trim()) return rejected("A body is required.");

  const roster = await loadComposeRecipients({ eventId: options.eventId, db });
  const byId = new Map(roster.map((recipient) => [recipient.personId, recipient]));
  const invalidCount = recipientIds.filter((personId) => !byId.has(personId)).length;
  if (invalidCount) {
    return rejected(
      `${invalidCount} selected recipient${invalidCount === 1 ? " does" : "s do"} not belong to this event. Nothing was sent.`,
    );
  }

  const now = options.now ?? new Date();

  /*
   * Idempotency claim. A concurrent duplicate (the double-click PR #208
   * reproduced, and issue #198 filed) must be rejected atomically — D1 has
   * no interactive transactions, so the atomicity comes from the UNIQUE
   * index on (event_id, idempotency_key) rejecting the insert itself, not
   * from a check-then-act SELECT that a second racing call could also pass.
   * The stale-claim delete keeps this a ROLLING window rather than a
   * permanent "this content may only ever be sent once".
   */
  const idempotencyKey = options.idempotencyKey?.trim() || hashBulkSendContent({
    eventId: options.eventId,
    recipients: recipientIds,
    subject: options.subject,
    body: options.body,
    audience: options.audience,
  });
  await db
    .delete(commBatches)
    .where(
      and(
        eq(commBatches.eventId, options.eventId),
        eq(commBatches.idempotencyKey, idempotencyKey),
        lt(commBatches.createdAt, new Date(now.getTime() - COMM_BATCH_DEDUP_WINDOW_MS)),
      ),
    );
  try {
    await db.insert(commBatches).values({ eventId: options.eventId, idempotencyKey });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejected(
        "This batch was already sent. Wait a moment and try again if you meant to resend it.",
      );
    }
    throw error;
  }

  const bulkId = crypto.randomUUID();
  const rows: BulkSendRow[] = [];
  for (const personId of recipientIds) {
    const recipient = byId.get(personId)!;
    const built = buildRecipientContext(recipient, options.event, {
      origin: options.origin,
      now,
    });
    const rendered = renderEmail(
      {
        key: (options.templateKey || BULK_CUSTOM_TEMPLATE_KEY) as never,
        subject: options.subject,
        body: options.body,
      },
      built.context,
    );
    const templateKey = options.templateKey || BULK_CUSTOM_TEMPLATE_KEY;
    const meta: Record<string, unknown> = {
      bulk: true,
      bulkId,
      audience: options.audience,
      fallbacksUsed: built.fallbacksUsed,
      ...(templateKey === "task_reminder" ? { taskIds: built.taskIds } : {}),
    };
    const mailer = withCommLog(nonThrowing(options.mailer), {
      eventId: options.eventId,
      personId,
      templateId: options.templateId ?? null,
      templateKey,
      meta,
      db,
      now,
    });
    const result = await mailer.send({
      to: recipient.email,
      subject: rendered.subject,
      text: rendered.text,
    });
    rows.push({
      email: recipient.email,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error ?? "unknown mailer failure" }),
    });
  }

  return {
    attempted: rows.length,
    sent: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
  };
}
