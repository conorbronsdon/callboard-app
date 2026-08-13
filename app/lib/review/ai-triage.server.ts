/**
 * AI triage — the binding + persistence half (ABS-14), advisory only.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * It is not a review. It never writes a `reviews` row, so it cannot reach
 * `aggregateFor()`, the abstracts table's aggregate column, the score sort or
 * the human columns of the reviewer CSV. It never changes a submission's
 * status. Organizer decisions stay human; the model gets a card and a label.
 *
 * ── Provider ────────────────────────────────────────────────────────────────
 * Cloudflare Workers AI through the native `AI` binding — no external API, no
 * new secret, nothing for a release operator to rotate. The binding is the
 * credential. When it is ABSENT (a deployment that dropped the `ai` block, or
 * any Vitest run, which has no bindings at all) every entry point returns
 * `{ status: "unavailable" }` and the UI says so out loud.
 *
 * ── Failure is stored, not swallowed ────────────────────────────────────────
 * A 70B instruct model asked for JSON returns JSON *most* of the time. The
 * remainder is the interesting case: `parseTriageText` never throws, and a
 * response it cannot read is persisted with `status = "failed"` and the raw
 * text in `reasoning`. An organizer sees "the model answered, we could not
 * read it, here is what it said" rather than a spinner that never resolves.
 *
 * ── Why there is a sibling ──────────────────────────────────────────────────
 * The prompt builder, the parser and the tuning constants live in the PURE
 * `ai-triage.ts` and are re-exported below. React Router hard-refuses to put a
 * `*.server` module in the client graph, and the abstracts toolbar needs
 * `AI_TRIAGE_BULK_CAP` in its button copy — a component-level import that
 * typechecked and BUILT clean and only failed in `vite dev`, as a full-screen
 * error overlay that ate the e2e run. Callers still import from one place.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import type { DB } from "~/db/client.server";
import { aiTriage, reviewRounds } from "~/db/schema";
import { appEnv } from "~/lib/env.server";
import {
  AI_TRIAGE_BULK_CAP,
  AI_TRIAGE_BULK_CONCURRENCY,
  AI_TRIAGE_CLAIM_STALE_MS,
  AI_TRIAGE_MODEL,
  RUBRIC_CRITERIA_MAX,
  SYSTEM_PROMPT,
  buildTriagePrompt,
  parseTriageText,
  textFromAiResponse,
  type AiTriageRecommendation,
  type TriageOpinion,
  type TriageSubmission,
} from "~/lib/review/ai-triage";
import { parseRubric } from "~/lib/review/scoring";

export {
  AI_TRIAGE_BULK_BATCH,
  AI_TRIAGE_BULK_CAP,
  AI_TRIAGE_BULK_CONCURRENCY,
  AI_TRIAGE_BULK_WINDOW_MS,
  AI_TRIAGE_CLAIM_STALE_MS,
  AI_TRIAGE_MODEL,
  RUBRIC_CRITERIA_MAX,
  AI_TRIAGE_RECOMMENDATIONS,
  AI_TRIAGE_STATUSES,
  SYSTEM_PROMPT,
  buildTriagePrompt,
  boundedTriageCount,
  parseTriageText,
  planTriageBatch,
  textFromAiResponse,
  triageBeginMarker,
  triageEndMarker,
  triageSentinel,
  triageWindowCap,
  type AiTriageRecommendation,
  type AiTriageStatus,
  type BulkBatchPlan,
  type TriageOpinion,
  type TriageParse,
  type TriageSubmission,
} from "~/lib/review/ai-triage";

/* ------------------------------------------------------------- the call */

/**
 * The one method this module needs from the binding. Structural on purpose: a
 * unit test injects a fake, and a fake that satisfies this satisfies the app.
 */
export interface TriageAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export type TriageOutcome =
  | { status: "ok"; model: string; opinion: TriageOpinion }
  | { status: "failed"; model: string; raw: string }
  | { status: "unavailable" };

/** The binding, or null when this deployment has none. */
export function triageBinding(): TriageAiBinding | null {
  const binding = appEnv().AI as unknown;
  if (!binding || typeof binding !== "object") return null;
  const run = (binding as { run?: unknown }).run;
  return typeof run === "function" ? (binding as TriageAiBinding) : null;
}

export async function requestTriage(
  ai: TriageAiBinding | null,
  submission: TriageSubmission,
  criteria: readonly string[] = [],
): Promise<TriageOutcome> {
  if (!ai) return { status: "unavailable" };

  let response: unknown;
  try {
    response = await ai.run(AI_TRIAGE_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildTriagePrompt(submission, undefined, criteria) },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
  } catch (error) {
    // A thrown call is a failed ATTEMPT, not an absent feature: the operator
    // configured the binding and it errored, and saying "unavailable" here
    // would hide a broken account behind a message about configuration.
    return {
      status: "failed",
      model: AI_TRIAGE_MODEL,
      raw: `The model call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseTriageText(textFromAiResponse(response));
  return parsed.ok
    ? { status: "ok", model: AI_TRIAGE_MODEL, opinion: parsed.opinion }
    : { status: "failed", model: AI_TRIAGE_MODEL, raw: parsed.raw || "The model returned no text." };
}

/* ------------------------------------------------------------ persistence */

export interface StoredTriage {
  score: number | null;
  recommendation: AiTriageRecommendation | null;
  reasoning: string | null;
  model: string;
  status: "ok" | "failed";
  createdAt: string | null;
}

/**
 * Upsert on `session_id`. One opinion per submission: "Run again" replaces the
 * row rather than stacking a second card the organizer has to date-compare.
 */
export async function storeTriageOutcome(
  db: DB,
  args: {
    eventId: string;
    sessionId: string;
    requestedById: string | null;
    outcome: Exclude<TriageOutcome, { status: "unavailable" }>;
  },
): Promise<void> {
  const { eventId, sessionId, requestedById, outcome } = args;
  const now = new Date();
  const values =
    outcome.status === "ok"
      ? {
          score: outcome.opinion.score,
          recommendation: outcome.opinion.recommendation,
          reasoning: outcome.opinion.reasoning,
          model: outcome.model,
          status: "ok" as const,
        }
      : {
          score: null,
          recommendation: null,
          reasoning: outcome.raw.slice(0, 1_200),
          model: outcome.model,
          status: "failed" as const,
        };

  await db
    .insert(aiTriage)
    .values({
      id: crypto.randomUUID(),
      eventId,
      sessionId,
      requestedById,
      ...values,
    })
    .onConflictDoUpdate({
      target: aiTriage.sessionId,
      set: { ...values, requestedById, updatedAt: now },
    });
}

export async function dismissTriage(
  db: DB,
  args: { eventId: string; sessionId: string },
): Promise<void> {
  await db
    .delete(aiTriage)
    .where(and(eq(aiTriage.eventId, args.eventId), eq(aiTriage.sessionId, args.sessionId)));
}

/** One submission, end to end. Returns the outcome so a caller can count it. */
export async function triageSubmission(
  db: DB,
  args: {
    eventId: string;
    sessionId: string;
    requestedById: string | null;
    submission: TriageSubmission;
    ai: TriageAiBinding | null;
    /** Current-round criterion names, or empty for the generic prompt. */
    criteria?: readonly string[];
  },
): Promise<TriageOutcome> {
  const outcome = await requestTriage(args.ai, args.submission, args.criteria ?? []);
  if (outcome.status === "unavailable") return outcome;
  await storeTriageOutcome(db, {
    eventId: args.eventId,
    sessionId: args.sessionId,
    requestedById: args.requestedById,
    outcome,
  });
  return outcome;
}

export interface BulkTriageTarget {
  sessionId: string;
  submission: TriageSubmission;
}

/**
 * Reserve targets before any billable model call.
 *
 * The existing `ai_triage_session_idx` unique index already is the one-row-per-
 * submission lock. A third `status = "claimed"` value reuses that lock plus
 * `updatedAt` as its staleness clock; SQLite stores `status` as unconstrained
 * text, so this is a TypeScript widening rather than a SQL schema change. A
 * separate claims table would duplicate the same uniqueness invariant and
 * retain history this workflow does not need.
 *
 * Each candidate first attempts INSERT ... ON CONFLICT DO NOTHING ...
 * RETURNING. SQLite returns a row only for the caller that actually inserted
 * it. A conflict then gets one magic-link-style conditional UPDATE: only a
 * still-claimed row older than the stale horizon can be reclaimed, and an empty
 * RETURNING set means this caller lost cleanly. Statements are intentionally
 * sequential—D1 has no interactive transactions—and the invariant lives in
 * each statement's WHERE/unique constraint rather than in an earlier read.
 * Stop at `take`: reserving work this request will not score would strand it.
 */
export async function claimTriageTargets(
  db: DB,
  args: {
    eventId: string;
    requestedById: string | null;
    candidates: readonly BulkTriageTarget[];
    take: number;
    now: Date;
  },
): Promise<BulkTriageTarget[]> {
  const requestedTake = Math.floor(Number(args.take));
  const take = Number.isFinite(requestedTake) ? Math.max(0, requestedTake) : 0;
  const staleBefore = new Date(args.now.getTime() - AI_TRIAGE_CLAIM_STALE_MS);
  const claimed: BulkTriageTarget[] = [];

  for (const candidate of args.candidates) {
    if (claimed.length >= take) break;

    const inserted = await db
      .insert(aiTriage)
      .values({
        id: crypto.randomUUID(),
        eventId: args.eventId,
        sessionId: candidate.sessionId,
        score: null,
        recommendation: null,
        reasoning: null,
        model: AI_TRIAGE_MODEL,
        status: "claimed",
        requestedById: args.requestedById,
        createdAt: args.now,
        updatedAt: args.now,
      })
      .onConflictDoNothing({ target: aiTriage.sessionId })
      .returning({ sessionId: aiTriage.sessionId });

    if (inserted.length > 0) {
      claimed.push(candidate);
      continue;
    }

    const reclaimed = await db
      .update(aiTriage)
      .set({
        score: null,
        recommendation: null,
        reasoning: null,
        model: AI_TRIAGE_MODEL,
        status: "claimed",
        requestedById: args.requestedById,
        updatedAt: args.now,
      })
      .where(
        and(
          eq(aiTriage.eventId, args.eventId),
          eq(aiTriage.sessionId, candidate.sessionId),
          eq(aiTriage.status, "claimed"),
          lt(aiTriage.updatedAt, staleBefore),
        ),
      )
      .returning({ sessionId: aiTriage.sessionId });

    if (reclaimed.length > 0) claimed.push(candidate);
  }

  return claimed;
}

/** Count spent or in-flight rows in a stable `createdAt` rolling window. */
export async function countRecentTriage(
  db: DB,
  args: { eventId: string; since: Date },
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiTriage)
    .where(and(eq(aiTriage.eventId, args.eventId), gte(aiTriage.createdAt, args.since)));
  return Number(rows[0]?.count ?? 0);
}

export interface BulkTriageResult {
  ok: number;
  failed: number;
  unavailable: boolean;
}

/**
 * Sequential in waves of `AI_TRIAGE_BULK_CONCURRENCY`, capped at
 * `AI_TRIAGE_BULK_CAP` rows. Both numbers are deliberate: a Worker request has
 * a wall-clock budget, and fanning twenty inference calls out at once is the
 * fastest way to turn a demo button into a 500.
 */
export async function triageMany(
  db: DB,
  args: {
    eventId: string;
    requestedById: string | null;
    targets: readonly BulkTriageTarget[];
    ai: TriageAiBinding | null;
    concurrency?: number;
    /** Current-round criterion names, applied to every prompt in the wave. */
    criteria?: readonly string[];
  },
): Promise<BulkTriageResult> {
  if (!args.ai) return { ok: 0, failed: 0, unavailable: true };

  const targets = args.targets.slice(0, AI_TRIAGE_BULK_CAP);
  const width = Math.max(1, args.concurrency ?? AI_TRIAGE_BULK_CONCURRENCY);
  let ok = 0;
  let failed = 0;

  for (let index = 0; index < targets.length; index += width) {
    const wave = targets.slice(index, index + width);
    const outcomes = await Promise.all(
      wave.map((target) =>
        triageSubmission(db, {
          eventId: args.eventId,
          sessionId: target.sessionId,
          requestedById: args.requestedById,
          submission: target.submission,
          ai: args.ai,
          criteria: args.criteria,
        }),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "ok") ok += 1;
      else if (outcome.status === "failed") failed += 1;
    }
  }

  return { ok, failed, unavailable: false };
}

/* ----------------------------------------------------------- the rubric */

/**
 * The criterion names of the event's CURRENT round — highest `ordinal`, the
 * same round the reviewer forms are scoring — for the prompt to speak in.
 *
 * Returns `[]` for an event with no rounds, which is the unchanged-prompt path
 * rather than an error: triage is meant to work before anyone has built a
 * rubric. Labels, not keys: `speaker_signal` is a column name, "Speaker signal"
 * is what the committee says out loud.
 */
export async function currentRoundCriteria(db: DB, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ rubric: reviewRounds.rubric })
    .from(reviewRounds)
    .where(eq(reviewRounds.eventId, eventId))
    .orderBy(desc(reviewRounds.ordinal))
    .limit(1);

  if (rows.length === 0) return [];
  /*
   * A round with a null rubric parses to the seeded default — which is exactly
   * what its reviewer form scores against, so the prompt and the form still
   * name the same criteria.
   */
  return parseRubric(rows[0].rubric)
    .criteria.map((criterion) => criterion.label)
    .slice(0, RUBRIC_CRITERIA_MAX);
}

/* ------------------------------------------------------------------ read */

export async function loadTriage(
  db: DB,
  args: { eventId: string; sessionId: string },
): Promise<StoredTriage | null> {
  const rows = await db
    .select({
      score: aiTriage.score,
      recommendation: aiTriage.recommendation,
      reasoning: aiTriage.reasoning,
      model: aiTriage.model,
      status: aiTriage.status,
      createdAt: aiTriage.createdAt,
    })
    .from(aiTriage)
    .where(and(eq(aiTriage.eventId, args.eventId), eq(aiTriage.sessionId, args.sessionId)))
    .limit(1);

  const row = rows[0];
  // A reservation is not an opinion. Until it resolves, the detail card has
  // nothing advisory to show and must not render nullable claim fields as one.
  if (!row || row.status === "claimed") return null;
  return {
    score: row.score,
    recommendation: row.recommendation,
    reasoning: row.reasoning,
    model: row.model,
    status: row.status,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}
