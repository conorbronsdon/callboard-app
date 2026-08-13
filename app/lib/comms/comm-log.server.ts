/**
 * The comm log: what was sent, to whom, and whether it worked.
 *
 * `withCommLog` is a Mailer DECORATOR rather than a helper each caller
 * remembers to invoke. Every send in the product goes through a `Mailer`, so
 * wrapping the mailer is what makes "every send is logged" a property of the
 * shape instead of a convention — including the failures. PLAN.md §7 lists
 * "comm-log row on mailer failure" as a binding verification addendum: a send
 * that fails silently is indistinguishable from one that was never attempted,
 * and the admin needs to be able to tell those apart.
 *
 * Writing the row must never take down the caller. A D1 hiccup while logging a
 * successful send would otherwise turn a delivered email into a 500 on the
 * agenda board.
 */
import { and, desc, eq, gte } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { commLog } from "~/db/schema";

import type { MailMessage, MailResult, Mailer } from "~/lib/mail/mailer";

export interface CommLogContext {
  eventId?: string | null;
  personId?: string | null;
  templateId?: string | null;
  /** Template KEY (`schedule_invite`), stored in meta — there is no key column. */
  templateKey?: string | null;
  meta?: Record<string, unknown>;
  /** Injectable for tests; defaults to the request-scoped handle. */
  db?: DB;
  now?: Date;
}

/** Template key of a logged row. Stored in `meta` since the column is an id. */
export function templateKeyOf(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>).templateKey;
  return typeof value === "string" ? value : null;
}

export async function recordComm(
  message: Pick<MailMessage, "to" | "subject">,
  result: MailResult,
  context: CommLogContext,
): Promise<void> {
  const db = context.db ?? getDb();
  const now = context.now ?? new Date();
  try {
    await db.insert(commLog).values({
      eventId: context.eventId ?? null,
      personId: context.personId ?? null,
      templateId: context.templateId ?? null,
      channel: "email",
      toEmail: message.to,
      subject: message.subject,
      status: result.ok ? "sent" : "failed",
      providerMessageId: result.id ?? null,
      error: result.ok ? null : (result.error ?? "unknown mailer failure"),
      meta: {
        ...(context.meta ?? {}),
        ...(context.templateKey ? { templateKey: context.templateKey } : {}),
      },
      sentAt: result.ok ? now : null,
      createdAt: now,
    });
  } catch (error) {
    // Deliberately swallowed, loudly. The email itself already succeeded or
    // failed; losing its audit row must not change that outcome.
    console.error(
      `[callboard] comm_log write failed for ${message.to} (${context.templateKey ?? "no template"}):`,
      error,
    );
  }
}

/**
 * Wrap a mailer so every send it performs writes a comm_log row.
 * `context` may be a function so per-message facts (which speaker) can be
 * resolved at send time from one wrapped instance.
 */
export function withCommLog(
  mailer: Mailer,
  context: CommLogContext | ((message: MailMessage) => CommLogContext),
): Mailer {
  return {
    name: mailer.name,
    // A comm_log row records what was attempted; it does not turn a local
    // driver into one that can confirm delivery. Forward the wrapped answer.
    observesDelivery: mailer.observesDelivery,
    async send(message: MailMessage): Promise<MailResult> {
      const result = await mailer.send(message);
      const resolved = typeof context === "function" ? context(message) : context;
      await recordComm(message, result, resolved);
      return result;
    },
  };
}

/* ----------------------------------------------------------------- reads */

export interface CommLogRow {
  id: string;
  toEmail: string;
  subject: string;
  status: string;
  error: string | null;
  templateKey: string | null;
  providerMessageId: string | null;
  createdAt: number;
  sentAt: number | null;
  meta: Record<string, unknown> | null;
}

/** Everything logged for an event, newest first; optionally one person only. */
export async function listComms(options: {
  eventId: string;
  personId?: string | null;
  since?: Date | null;
  limit?: number;
  db?: DB;
}): Promise<CommLogRow[]> {
  const db = options.db ?? getDb();
  const filters = [eq(commLog.eventId, options.eventId)];
  if (options.personId) filters.push(eq(commLog.personId, options.personId));
  if (options.since) filters.push(gte(commLog.createdAt, options.since));

  const rows = await db
    .select()
    .from(commLog)
    .where(and(...filters))
    .orderBy(desc(commLog.createdAt))
    .limit(options.limit ?? 200);

  return rows.map((row) => ({
    id: row.id,
    toEmail: row.toEmail,
    subject: row.subject,
    status: row.status,
    error: row.error,
    templateKey: templateKeyOf(row.meta),
    providerMessageId: row.providerMessageId,
    createdAt: new Date(row.createdAt).getTime(),
    sentAt: row.sentAt ? new Date(row.sentAt).getTime() : null,
    meta: (row.meta ?? null) as Record<string, unknown> | null,
  }));
}
