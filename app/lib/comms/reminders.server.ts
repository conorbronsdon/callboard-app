/**
 * The `task-reminders` job body.
 *
 * Cron never fires in `wrangler dev` (AGENTS.md), so this is written to be run
 * from `POST /admin/jobs/run?name=task-reminders` and returns counts detailed
 * enough that the run output IS the evidence: how many candidates, how many
 * sent, how many suppressed by the cadence, how many failed.
 *
 * Reads only. The dedupe state is the comm_log rows the job itself writes, so
 * a second run inside the cadence is a no-op with nothing to clean up.
 */
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { commLog, events, forms, people, tasks } from "~/db/schema";
import { appUrl } from "~/lib/env.server";
import type { JobContext, JobResult } from "~/lib/jobs/registry.server";
import { getMailer } from "~/lib/mail/mailer.server";
import type { Mailer } from "~/lib/mail/mailer";

import { withCommLog } from "./comm-log.server";
import {
  DEFAULT_REMINDER_POLICY,
  formatDue,
  formatTaskList,
  selectReminders,
  type PriorReminder,
  type ReminderPolicy,
  type ReminderTask,
} from "./reminders";
import { firstNameOf } from "./schedule-invite";
import { mergeContext, renderEmail } from "./templates";
import { loadTemplate } from "./templates.server";

const DAY_MS = 86_400_000;
const TEMPLATE_KEY = "task_reminder" as const;

export interface ReminderRunOptions {
  db?: DB;
  mailer?: Mailer;
  policy?: Partial<ReminderPolicy>;
  /** Absolute origin for portal links; cron has no request to take one from. */
  origin?: string;
  /** Restrict to one event. Default: every event with open tasks. */
  eventId?: string;
  /** Build the messages and report, but send nothing. */
  dryRun?: boolean;
}

export interface ReminderRunDetails extends Record<string, unknown> {
  events: number;
  candidates: number;
  batches: number;
  sent: number;
  failed: number;
  suppressed: number;
  recipients: string[];
}

/**
 * Prior reminders for these tasks, from the comm_log rows this job wrote.
 *
 * `status = "sent"` is load-bearing: a send the provider REJECTED never reached
 * the speaker, so counting it as a reminder would silently retire the task from
 * the reminder set for a full cadence. Failures are logged (they have to be)
 * but they do not suppress the retry.
 */
async function priorReminders(
  db: DB,
  eventId: string,
  since: Date,
): Promise<PriorReminder[]> {
  const rows = await db
    .select({ meta: commLog.meta, createdAt: commLog.createdAt })
    .from(commLog)
    .where(
      and(
        eq(commLog.eventId, eventId),
        eq(commLog.status, "sent"),
        gte(commLog.createdAt, since),
        sql`json_extract(${commLog.meta}, '$.templateKey') = ${TEMPLATE_KEY}`,
      ),
    );

  const prior: PriorReminder[] = [];
  for (const row of rows) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(meta.taskIds) ? meta.taskIds : [];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      prior.push({ taskId: id, sentAt: new Date(row.createdAt).getTime() });
    }
  }
  return prior;
}

/**
 * A reminder about a task that embeds a form must respect that form's close
 * date. Everything else has no form and is never gated.
 */
async function formCloseDates(db: DB, formIds: string[]): Promise<Map<string, number | null>> {
  if (formIds.length === 0) return new Map();
  const rows = await db
    .select({ id: forms.id, closesAt: forms.closesAt, status: forms.status })
    .from(forms)
    .where(inArray(forms.id, formIds));
  return new Map(
    rows.map((row) => [
      row.id,
      // A form an admin has explicitly CLOSED gates the reminder just as a
      // past close date does — the speaker cannot act either way.
      row.status === "closed" ? 0 : row.closesAt ? new Date(row.closesAt).getTime() : null,
    ]),
  );
}

export async function runTaskReminders(
  context: JobContext,
  options: ReminderRunOptions = {},
): Promise<JobResult> {
  const db = options.db ?? getDb();
  const policy = { ...DEFAULT_REMINDER_POLICY, ...(options.policy ?? {}) };
  const now = context.now;
  const nowMs = now.getTime();

  const eventRows = options.eventId
    ? await db.select().from(events).where(eq(events.id, options.eventId))
    : await db.select().from(events);

  const details: ReminderRunDetails = {
    events: eventRows.length,
    candidates: 0,
    batches: 0,
    sent: 0,
    failed: 0,
    suppressed: 0,
    recipients: [],
  };

  const base = options.mailer ?? getMailer();
  let origin: string;
  try {
    origin = options.origin ?? appUrl(context.request ?? null);
  } catch {
    // Cron with no APP_URL configured: still report, still log, but a portal
    // link we cannot build must not silently become "undefined/portal".
    return {
      ok: false,
      message:
        "task-reminders: APP_URL is not set, so portal links cannot be built. Set it before enabling the cron.",
      details,
    };
  }

  for (const event of eventRows) {
    const rows = await db
      .select({
        taskId: tasks.id,
        personId: tasks.personId,
        email: people.email,
        name: people.fullName,
        title: tasks.title,
        status: tasks.status,
        dueAt: tasks.dueAt,
        formId: tasks.formId,
      })
      .from(tasks)
      .innerJoin(people, eq(people.id, tasks.personId))
      .where(and(eq(tasks.eventId, event.id), isNotNull(tasks.dueAt)));

    if (rows.length === 0) continue;

    const closeDates = await formCloseDates(
      db,
      [...new Set(rows.map((row) => row.formId).filter((id): id is string => Boolean(id)))],
    );

    const candidates: ReminderTask[] = rows.map((row) => ({
      taskId: row.taskId,
      personId: row.personId,
      email: row.email,
      name: row.name,
      title: row.title,
      status: row.status,
      dueAt: row.dueAt ? new Date(row.dueAt).getTime() : null,
      formClosesAt: row.formId ? (closeDates.get(row.formId) ?? null) : null,
    }));
    details.candidates += candidates.length;

    const prior = await priorReminders(
      db,
      event.id,
      new Date(nowMs - policy.cadenceDays * DAY_MS),
    );
    const withoutDedupe = selectReminders({ now: nowMs, tasks: candidates, policy });
    const batches = selectReminders({ now: nowMs, tasks: candidates, prior, policy });
    details.suppressed +=
      withoutDedupe.reduce((total, batch) => total + batch.tasks.length, 0) -
      batches.reduce((total, batch) => total + batch.tasks.length, 0);
    details.batches += batches.length;

    if (batches.length === 0) continue;

    const template = await loadTemplate(event.id, TEMPLATE_KEY, db);

    for (const batch of batches) {
      const rendered = renderEmail(
        template,
        mergeContext({
          "speaker.name": batch.name ?? batch.email,
          "speaker.first_name": firstNameOf(batch.name) ?? batch.email,
          "speaker.email": batch.email,
          "event.name": event.name,
          "event.location": event.location ?? "",
          "task.count": String(batch.tasks.length),
          "task.list": formatTaskList(batch, nowMs, event.timezone),
          "task.due": formatDue(batch.soonestDueAt, event.timezone),
          "portal.url": `${origin}/portal`,
        }),
      );

      const message = { to: batch.email, subject: rendered.subject, text: rendered.text };

      if (options.dryRun) {
        details.recipients.push(`${batch.email} (${batch.tasks.length}) [dry-run]`);
        continue;
      }

      const mailer = withCommLog(base, {
        eventId: event.id,
        personId: batch.personId,
        templateId: template.id,
        templateKey: TEMPLATE_KEY,
        // The dedupe key. Every task named in this email is stamped here, so
        // the next run knows exactly which ones were already chased.
        meta: {
          taskIds: batch.tasks.map((task) => task.taskId),
          taskCount: batch.tasks.length,
          overdueCount: batch.overdueCount,
        },
        db,
        now,
      });

      const result = await mailer.send(message);
      if (result.ok) {
        details.sent += 1;
        details.recipients.push(`${batch.email} (${batch.tasks.length})`);
      } else {
        details.failed += 1;
        details.recipients.push(`${batch.email} (${batch.tasks.length}) [FAILED]`);
      }
    }
  }

  const summary =
    details.batches === 0
      ? `task-reminders: nothing due — ${details.candidates} task(s) checked, ${details.suppressed} suppressed by the ${policy.cadenceDays}-day cadence.`
      : `task-reminders: ${details.sent} sent, ${details.failed} failed, ${details.suppressed} suppressed by the ${policy.cadenceDays}-day cadence (${details.candidates} task(s) checked).`;

  return { ok: details.failed === 0, message: summary, details };
}
