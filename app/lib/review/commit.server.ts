/**
 * "Commit queues" — the staging mechanic that makes the 7-state pipeline worth
 * having (DECISIONS.md #15). Everything sitting in Accept Queue becomes
 * `accepted`, everything in Decline Queue becomes `declined`, and both happen in
 * one reviewed action instead of one row at a time.
 *
 * An accept does three things, which is the whole point of committing rather
 * than flipping a status:
 *   1. composes the abstract into a program SESSION (`is_abstract = false`,
 *      `composed_into_session_id` back-link — DECISIONS.md #3), so the agenda
 *      lane has something to place;
 *   2. copies the abstract's participants onto that session;
 *   3. instantiates the event's `task_templates` as real `tasks` for every
 *      accepted speaker, which is what the speaker portal and the onboarding
 *      dashboard read.
 *
 * D1 rules that shape the code (AGENTS.md "stack landmines"): no interactive
 * transactions, so writes go through a single `db.batch()`; 100 bound
 * parameters per statement, so multi-row inserts are chunked with
 * `chunkedInsert` and IN lists with `chunkForBind`.
 */
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { chunkForBind, chunkedInsert, getDb, type DB } from "~/db/client.server";
import {
  reviewRounds,
  sessionParticipants,
  sessions,
  taskTemplates,
  tasks,
} from "~/db/schema";
import type { Mailer } from "~/lib/mail/mailer";
import { emitWebhook } from "~/lib/webhooks/webhooks.server";

import { notifyDecisions } from "./decision-notify.server";
import {
  planQueueCommit,
  type AdminAssignableStatus,
  type QueueCommitPlan,
} from "./pipeline";

export interface CommitQueuesResult {
  /** The round the commit was recorded against (created on first commit). */
  roundId: string;
  roundCreated: boolean;
  accepted: number;
  declined: number;
  sessionsComposed: number;
  tasksCreated: number;
  notified: number;
  notifyFailed: number;
  /** Ids the commit deliberately left alone — pending, drafts, withdrawn… */
  untouched: number;
}

type Statement = BatchItem<"sqlite">;

interface AcceptComposition {
  statements: Statement[];
  /** Abstract id -> new programme session id, for the back-link updates. */
  composedBy: Map<string, string>;
  sessionsComposed: number;
  tasksCreated: number;
}

/**
 * ONE `db.batch()` call, deliberately. D1 is all-or-nothing across the
 * statements in a single batch, and a commit that composed program sessions but
 * never wrote the abstracts' back-links is a corrupt programme, not a partial
 * one. This used to slice into 20-statement batches, which meant a large commit
 * was several independent transactions; chunking for the parameter cap raises
 * the statement count, so that seam had to close rather than widen.
 */
async function runBatch(db: DB, statements: Statement[]): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as [Statement, ...Statement[]]);
}

/**
 * The single minimal round record. Multi-round UI (teams, batch assignment,
 * rubric scoring) is a later slice; what the vertical slice needs is that a
 * commit is *recorded against a round*, so create round 1 on first commit if
 * the event has none.
 */
async function ensureRound(
  db: DB,
  eventId: string,
  now: Date,
): Promise<{ roundId: string; created: boolean }> {
  const existing = await db.query.reviewRounds.findFirst({
    where: eq(reviewRounds.eventId, eventId),
    orderBy: [asc(reviewRounds.ordinal)],
  });
  if (existing) return { roundId: existing.id, created: false };

  const roundId = crypto.randomUUID();
  await db.insert(reviewRounds).values({
    id: roundId,
    eventId,
    name: "Round 1 — screening",
    ordinal: 1,
    opensAt: now,
  });
  return { roundId, created: true };
}

/**
 * The composition an accept performs, as a plan rather than an effect.
 *
 * This is the whole reason the two accept paths can no longer drift: the queue
 * commit and the status radio both build their writes HERE. A second copy of
 * this logic is exactly what shipped an "Accepted" abstract with no programme
 * session, no participants and no tasks.
 */
async function planAcceptComposition(
  db: DB,
  eventId: string,
  abstractIds: readonly string[],
  now: Date,
  options: { skipAlreadyComposed: boolean },
): Promise<AcceptComposition> {
  if (abstractIds.length === 0) {
    return { statements: [], composedBy: new Map(), sessionsComposed: 0, tasksCreated: 0 };
  }

  /* ------------------------------------------------- gather what we need */

  // Both reads are IN lists over the accept queue, so they scale with the size
  // of the commit and need the same chunking as the writes below.
  const accepting = (
    await Promise.all(
      chunkForBind([...abstractIds], 1).map((chunk) =>
        db
          .select()
          .from(sessions)
          .where(
            and(
              inArray(sessions.id, chunk),
              eq(sessions.eventId, eventId),
              eq(sessions.isAbstract, true),
              isNull(sessions.deletedAt),
            ),
          ),
      ),
    )
  ).flat();

  /*
   * `skipAlreadyComposed` is what makes a repeated DIRECT accept idempotent
   * (ABS-32): the status radio is a single-row control an organizer can hit on
   * a row that was already accepted, and a second programme session for the
   * same talk is a corrupt agenda, not a retry.
   *
   * The queue commit does NOT opt in. Re-committing a row that already owns a
   * programme session is a different question with its own history
   * (`commit.bound-params.test.ts` pins today's answer), and changing it is not
   * this lane's job. The COMPOSITION is shared either way, which is the drift
   * this fix exists to close.
   *
   * The predicate is deliberately the speaker portal's programme lookup, so
   * "the portal thinks the talk is fine" and "the composer thinks the talk is
   * composed" cannot disagree. A dangling or soft-deleted back-link is
   * repairable, not "already composed".
   */
  const linkedIds = options.skipAlreadyComposed
    ? [
        ...new Set(
          accepting
            .map((abstract) => abstract.composedIntoSessionId)
            .filter((id): id is string => id !== null),
        ),
      ]
    : [];
  const liveProgrammes = (
    await Promise.all(
      chunkForBind(linkedIds, 1).map((chunk) =>
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              inArray(sessions.id, chunk),
              eq(sessions.eventId, eventId),
              eq(sessions.isAbstract, false),
              isNull(sessions.deletedAt),
            ),
          ),
      ),
    )
  ).flat();
  const liveProgrammeIds = new Set(liveProgrammes.map((row) => row.id));
  const toCompose = accepting.filter(
    (abstract) =>
      abstract.composedIntoSessionId === null ||
      !liveProgrammeIds.has(abstract.composedIntoSessionId),
  );
  const composeIds = toCompose.map((abstract) => abstract.id);

  const participants = (
    await Promise.all(
      chunkForBind(composeIds, 1).map((chunk) =>
        db
          .select()
          .from(sessionParticipants)
          .where(inArray(sessionParticipants.sessionId, chunk)),
      ),
    )
  ).flat();

  const templates = toCompose.length
    ? await db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.eventId, eventId))
        .orderBy(asc(taskTemplates.order))
    : [];

  // Never hand a speaker the same onboarding task twice — a second commit after
  // a partial failure must be safe to run.
  const existingTasks = toCompose.length
    ? await db
        .select({
          templateId: tasks.templateId,
          personId: tasks.personId,
          sessionId: tasks.sessionId,
        })
        .from(tasks)
        .where(eq(tasks.eventId, eventId))
    : [];
  const taskSeen = new Set(
    existingTasks.map((row) => `${row.templateId}|${row.personId}|${row.sessionId}`),
  );

  /* ------------------------------------------------------- build writes */

  const programRows: (typeof sessions.$inferInsert)[] = [];
  const participantRows: (typeof sessionParticipants.$inferInsert)[] = [];
  const taskRows: (typeof tasks.$inferInsert)[] = [];
  const composedBy = new Map<string, string>();

  for (const abstract of toCompose) {
    const programId = crypto.randomUUID();
    composedBy.set(abstract.id, programId);

    programRows.push({
      id: programId,
      eventId,
      title: abstract.title,
      description: abstract.description,
      status: "accepted",
      isAbstract: false,
      trackId: abstract.trackId,
      formatId: abstract.formatId,
      levelId: abstract.levelId,
      // Times/room stay empty on purpose: an accepted talk is unscheduled until
      // the agenda builder places it. That is the dashboard's "needs a slot".
      capacity: abstract.capacity,
      isPublic: false,
      createdAt: now,
      updatedAt: now,
    });

    const own = participants.filter((row) => row.sessionId === abstract.id);
    for (const participant of own) {
      participantRows.push({
        sessionId: programId,
        personId: participant.personId,
        role: participant.role,
        isPrimary: participant.isPrimary,
        order: participant.order,
      });

      for (const template of templates) {
        const key = `${template.id}|${participant.personId}|${programId}`;
        if (taskSeen.has(key)) continue;
        taskSeen.add(key);
        taskRows.push({
          id: crypto.randomUUID(),
          eventId,
          templateId: template.id,
          personId: participant.personId,
          sessionId: programId,
          title: template.title,
          description: template.description,
          kind: template.formId ? "form" : "manual",
          formId: template.formId,
          status: "pending",
          dueAt:
            template.dueOffsetDays === null
              ? null
              : new Date(now.getTime() + template.dueOffsetDays * 86_400_000),
        });
      }
    }
  }

  const statements: Statement[] = [];

  // Order matters: FK parents (program sessions) before children
  // (participants, tasks), and the abstract's back-link last.
  statements.push(
    ...chunkedInsert(programRows, (chunk) => db.insert(sessions).values(chunk)),
  );
  statements.push(
    ...chunkedInsert(participantRows, (chunk) =>
      db.insert(sessionParticipants).values(chunk),
    ),
  );
  statements.push(...chunkedInsert(taskRows, (chunk) => db.insert(tasks).values(chunk)));
  for (const [abstractId, programId] of composedBy) {
    statements.push(
      db
        .update(sessions)
        .set({ status: "accepted", composedIntoSessionId: programId, updatedAt: now })
        .where(eq(sessions.id, abstractId)),
    );
  }

  return {
    statements,
    composedBy,
    sessionsComposed: programRows.length,
    tasksCreated: taskRows.length,
  };
}

export interface DirectStatusResult {
  status: AdminAssignableStatus;
  sessionsComposed: number;
  tasksCreated: number;
  notified: number;
  notifyFailed: number;
}

/**
 * The single-row counterpart to `commitQueues`: the status RADIO on the
 * abstracts table and on the submission detail page.
 *
 * One composer, one notifier, two callers. Accepting here does everything a
 * committed accept does — composes the programme session, copies participants,
 * fires task templates, and sends the decision email — because an organizer
 * has no way to know which of the two controls is the "real" one, and the
 * product cannot afford them to mean different things.
 */
export async function applyAbstractStatus(input: {
  eventId: string;
  abstractId: string;
  status: AdminAssignableStatus;
  now?: Date;
  origin?: string;
  mailer?: Mailer;
  db?: DB;
  notify?: boolean;
}): Promise<DirectStatusResult> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  /*
   * Read the status BEFORE writing, because "did this transition happen?" is
   * what decides whether a speaker hears about it. Re-asserting a decision the
   * row already carries is a no-op click, not a new decision, and mailing a
   * second acceptance for it is the kind of thing speakers screenshot.
   *
   * This is the same rule the queue commit follows for free: `planQueueCommit`
   * only ever hands it rows sitting in a QUEUE, so a committed row is never
   * re-decided either.
   */
  const before = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.id, input.abstractId),
      eq(sessions.eventId, input.eventId),
      eq(sessions.isAbstract, true),
    ),
  });
  const transitioned = before !== undefined && before.status !== input.status;

  let composition: AcceptComposition = {
    statements: [],
    composedBy: new Map(),
    sessionsComposed: 0,
    tasksCreated: 0,
  };

  if (input.status === "accepted") {
    composition = await planAcceptComposition(db, input.eventId, [input.abstractId], now, {
      skipAlreadyComposed: true,
    });
    await runBatch(db, [
      ...composition.statements,
      // Belt and braces: an abstract skipped by the composer because it already
      // owns a live programme session still has to come out of this ACCEPTED.
      // Composing nothing must never decay into doing nothing.
      db
        .update(sessions)
        .set({ status: "accepted", updatedAt: now })
        .where(eq(sessions.id, input.abstractId)),
    ]);
  } else {
    await db
      .update(sessions)
      .set({ status: input.status, updatedAt: now })
      .where(eq(sessions.id, input.abstractId));
  }

  // After the write is durable, exactly like the queue commit: a provider
  // failure must not roll back a decision the organizer already made.
  const decided = input.status === "accepted" || input.status === "declined";
  const notification =
    input.notify === false || !decided || !transitioned
      ? { notified: 0, failed: 0 }
      : await notifyDecisions({
          eventId: input.eventId,
          accepted: input.status === "accepted" ? [input.abstractId] : [],
          declined: input.status === "declined" ? [input.abstractId] : [],
          origin: input.origin,
          mailer: input.mailer,
          db,
          now,
        });

  if (decided && transitioned) {
    await emitWebhook("decision.committed", input.abstractId, {
      eventId: input.eventId,
      status: input.status,
    });
  }

  return {
    status: input.status,
    sessionsComposed: composition.sessionsComposed,
    tasksCreated: composition.tasksCreated,
    notified: notification.notified,
    notifyFailed: notification.failed,
  };
}

export async function commitQueues(
  eventId: string,
  options: {
    now?: Date;
    origin?: string;
    mailer?: Mailer;
    db?: DB;
    notify?: boolean;
  } = {},
): Promise<CommitQueuesResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  // Read the WHOLE abstract pool for the event, not just the queues: the plan
  // is what decides which rows are eligible, and `untouched` is then a real
  // count of rows the commit declined to touch rather than an assumption.
  const pool = await db
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
      ),
    );

  const plan: QueueCommitPlan = planQueueCommit(pool);
  const round = await ensureRound(db, eventId, now);

  if (plan.accept.length === 0 && plan.decline.length === 0) {
    return {
      roundId: round.roundId,
      roundCreated: round.created,
      accepted: 0,
      declined: 0,
      sessionsComposed: 0,
      tasksCreated: 0,
      notified: 0,
      notifyFailed: 0,
      untouched: plan.untouched.length,
    };
  }

  const composition = await planAcceptComposition(db, eventId, plan.accept, now, {
    skipAlreadyComposed: false,
  });
  const statements: Statement[] = [...composition.statements];

  // Each declined id is one bound parameter in the IN list, and the SET clause
  // costs two more — budget 2 per id so a full chunk lands at ~47, not ~92.
  for (const chunk of chunkForBind(plan.decline, 2)) {
    statements.push(
      db
        .update(sessions)
        .set({ status: "declined", updatedAt: now })
        .where(inArray(sessions.id, chunk)),
    );
  }

  await runBatch(db, statements);

  // The batch is already durable before email begins. Notification failures
  // therefore cannot roll back decisions, composed sessions, or speaker tasks.
  const notification =
    options.notify === false
      ? { notified: 0, failed: 0 }
      : await notifyDecisions({
          eventId,
          accepted: plan.accept,
          declined: plan.decline,
          origin: options.origin,
          mailer: options.mailer,
          db,
          now,
        });

  for (const abstractId of plan.accept) {
    await emitWebhook("decision.committed", abstractId, { eventId, status: "accepted" });
  }
  for (const abstractId of plan.decline) {
    await emitWebhook("decision.committed", abstractId, { eventId, status: "declined" });
  }

  return {
    roundId: round.roundId,
    roundCreated: round.created,
    accepted: plan.accept.length,
    declined: plan.decline.length,
    sessionsComposed: composition.sessionsComposed,
    tasksCreated: composition.tasksCreated,
    notified: notification.notified,
    notifyFailed: notification.failed,
    untouched: plan.untouched.length,
  };
}
