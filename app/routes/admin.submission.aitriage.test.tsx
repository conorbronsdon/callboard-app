/**
 * ABS-14 mutation controls: the AI first pass is advisory, separate, labelled,
 * and locked to admins.
 *
 * The claim this feature makes is not "a model can score an abstract" — that is
 * the easy half. It is "a model's opinion cannot leak into a human number".
 * Every guarantee below therefore has a must-FIRE assertion (the feature does
 * the thing) beside a must-NOT-fire one (the thing it must never do), and the
 * isolation tests measure the human aggregate BEFORE and AFTER the AI row
 * exists rather than asserting on the AI row alone — a filter that silently
 * stopped filtering would still pass the second kind.
 *
 * There is no Workers AI binding under Vitest. That is not a gap: it IS the
 * degradation path a deployment without the `ai` block takes, so the tests
 * exercise both — bindingless by default, and a fake injected through
 * `installTestDb({ AI: ... })` where a real call is the point.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiTriage, reviewRounds, reviews, sessions } from "~/db/schema";
import { AI_TRIAGE_MODEL } from "~/lib/review/ai-triage.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  SubmissionDetailView,
  action,
  loader,
  submissionLoaderPayload,
} from "./admin.submission";
import { loader as listLoader } from "./admin.submissions";
import { loader as csvLoader } from "./admin.submissions.scores.csv";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const ROUND = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const REVIEW = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";

const asLoaderArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as ActionArgs;
const asListArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as Parameters<typeof listLoader>[0];
const asCsvArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as Parameters<typeof csvLoader>[0];

/** A binding-shaped stub. Structural, so satisfying it is satisfying the app. */
function fakeAi(reply: string) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  return {
    calls,
    async run(model: string, inputs: Record<string, unknown>) {
      calls.push({ model, inputs });
      return { response: reply };
    },
  };
}

const GOOD_REPLY = JSON.stringify({
  score: 4,
  recommendation: "maybe",
  reasoning: "The premise is specific and the outcome is measurable. The scope is wide for the slot.",
});

let ctx: TestDbContext;
let fixture: DemoFixture;
/** The abstract the human review below is attached to. */
let scored: string;

async function seed(overrides: Record<string, unknown> = {}) {
  ctx = installTestDb(overrides);
  fixture = await seedDemoFixture(ctx.db);
  scored = fixture.abstractIds[3];

  await ctx.db.insert(reviewRounds).values({
    id: ROUND,
    eventId: fixture.eventId,
    name: "Screening",
    ordinal: 1,
    rubric: {
      criteria: [
        { key: "originality", label: "Originality", min: 1, max: 5, weight: 2 },
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  await ctx.db.insert(reviews).values({
    id: REVIEW,
    roundId: ROUND,
    sessionId: scored,
    reviewerId: fixture.adminId,
    scores: { originality: 4, relevance: 3 },
    totalScore: 11,
    submittedAt: new Date("2026-08-10T12:00:00Z"),
  });
}

async function insertTriage(sessionId: string, patch: Record<string, unknown> = {}) {
  await ctx.db.insert(aiTriage).values({
    id: crypto.randomUUID(),
    eventId: fixture.eventId,
    sessionId,
    score: 5,
    recommendation: "accept",
    reasoning: "Strong fit and a concrete outcome. Little overlap with the rest of the slate.",
    model: `${AI_TRIAGE_MODEL} (seeded example)`,
    status: "ok",
    ...patch,
  });
}

async function detail(id: string) {
  const request = await signedInGet(
    `https://x.test/admin/submissions/${id}?tab=pending`,
    fixture.adminId,
  );
  return submissionLoaderPayload(await loader(asLoaderArgs(request, id)));
}

async function post(id: string, fields: Record<string, string>, personId = fixture.adminId) {
  const request = await signedInPost(
    `https://x.test/admin/submissions/${id}`,
    personId,
    fields,
  );
  return action(asActionArgs(request, id));
}

async function listRows() {
  const request = await signedInGet(
    "https://x.test/admin/submissions?tab=pending",
    fixture.adminId,
  );
  const data = await listLoader(asListArgs(request));
  return data.rows;
}

async function csvText() {
  const request = await signedInGet(
    "https://x.test/admin/submissions/scores.csv",
    fixture.adminId,
  );
  const response = await csvLoader(asCsvArgs(request));
  return await (response as Response).text();
}

async function triageRowCount() {
  const rows = await ctx.db.select().from(aiTriage);
  return rows.length;
}

afterEach(() => ctx.close());

/* ───────────────────────── isolation from human numbers ───────────────── */

describe("an AI opinion never becomes a human number", () => {
  beforeEach(() => seed());

  it("must-not-fire: adding an AI row changes no human aggregate value", async () => {
    const before = await listRows();
    const beforeScored = before.find((row) => row.id === scored);
    // Control: if the human review did not land, "unchanged" would be vacuous.
    expect(beforeScored?.reviewCount).toBe(1);
    expect(beforeScored?.aggregateScore).toBeCloseTo(11 / 3, 5);

    await insertTriage(scored);
    // ...and on an abstract with NO human review at all, where a leak would be
    // most visible: null must stay null rather than become 5.
    const unreviewed = before.find((row) => row.id !== scored && row.aggregateScore === null);
    expect(unreviewed, "fixture has no unreviewed pending abstract").toBeDefined();
    await insertTriage(unreviewed!.id, { score: 1, recommendation: "reject" });

    const after = await listRows();
    expect(after.map((row) => [row.id, row.reviewCount, row.aggregateScore])).toEqual(
      before.map((row) => [row.id, row.reviewCount, row.aggregateScore]),
    );
    expect(await triageRowCount()).toBe(2); // the rows really are there
  });

  it("must-not-fire: adding an AI row does not reorder sort-by-score", async () => {
    const request = await signedInGet(
      "https://x.test/admin/submissions?tab=pending&sort=score-desc",
      fixture.adminId,
    );
    const before = (await listLoader(asListArgs(request))).rows.map((row) => row.id);
    expect(before.length).toBeGreaterThan(1);

    // A 5/5 on the row that currently sorts LAST. If the AI score reached the
    // sort, this row would jump to the front.
    await insertTriage(before[before.length - 1]);

    const after = (await listLoader(asListArgs(request))).rows.map((row) => row.id);
    expect(after).toEqual(before);
  });

  it("must-fire: the CSV grows an advisory column; must-not-fire: the human columns do not move", async () => {
    const before = await csvText();
    const beforeLines = before.trim().split(/\r?\n/);
    expect(beforeLines[0]).toContain("AI triage score (advisory)");
    expect(beforeLines[0]).toContain("AI triage recommendation (advisory)");

    await insertTriage(scored);
    const after = await csvText();
    const afterLines = after.trim().split(/\r?\n/);

    expect(afterLines).toHaveLength(beforeLines.length);
    // must-fire: the advisory value is actually exported.
    const scoredRow = afterLines.find((line) => line.includes("Cost modelling"));
    expect(scoredRow, "the scored abstract is missing from the CSV").toBeDefined();
    expect(scoredRow).toContain(",5,accept");

    // must-not-fire: strip the two trailing advisory fields and the rest of
    // every row is byte-identical to the pre-AI export.
    const trimTrailing = (line: string) => line.split(",").slice(0, -2).join(",");
    expect(afterLines.map(trimTrailing)).toEqual(beforeLines.map(trimTrailing));
  });

  it("must-not-fire: a failed AI attempt exports no advisory score at all", async () => {
    /*
     * The row carries a score AND a recommendation even though it is marked
     * failed. That combination is not one the app writes today, and that is
     * the point: the export filters on `status`, not on "did the columns
     * happen to be null". The first version of this test seeded a failed row
     * with null columns, so deleting the status filter changed nothing and the
     * assertion passed either way — mutation control M6 caught it.
     */
    await insertTriage(scored, {
      status: "failed",
      score: 5,
      recommendation: "accept",
      reasoning: "I cannot comply with that request.",
    });
    const row = (await csvText())
      .trim()
      .split(/\r?\n/)
      .find((line) => line.includes("Cost modelling"));
    expect(row).toBeDefined();
    expect(row).not.toContain("I cannot comply");
    expect(row).not.toContain(",5,accept");
    expect(row!.endsWith(",,")).toBe(true);
  });
});

/* ─────────────────────────────── rendering + labelling ────────────────── */

describe("the triage card says who wrote it", () => {
  beforeEach(() => seed());

  it("must-fire: a stored row renders its score, recommendation and model label", async () => {
    await insertTriage(scored);
    const data = await detail(scored);
    expect(data.triage?.status).toBe("ok");
    expect(data.triage?.score).toBe(5);

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("AI triage");
    expect(html).toContain("Advisory only — decisions stay with your committee.");
    expect(html).toContain(`AI-generated (${AI_TRIAGE_MODEL} (seeded example))`);
    expect(html).toContain("Lean accept");
    expect(html).toContain("Strong fit and a concrete outcome.");
  });

  it("must-fire: a failed attempt renders the failure and what the model said", async () => {
    await insertTriage(scored, {
      status: "failed",
      score: null,
      recommendation: null,
      reasoning: "Sure! Here is my answer: the talk is good.",
      model: AI_TRIAGE_MODEL,
    });
    const data = await detail(scored);
    expect(data.triage?.status).toBe("failed");

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("not in a form we could read");
    expect(html).toContain("Sure! Here is my answer");
    expect(html).toContain(`AI-generated (${AI_TRIAGE_MODEL})`);
    expect(html).toContain("Save your score");
    // must-not-fire: a failure must not render as a score of zero.
    expect(html).not.toContain("Lean accept");
  });

  it("must-fire: with no binding and no row the card says it is unavailable, not empty", async () => {
    const data = await detail(fixture.abstractIds[4]);
    expect(data.aiAvailable).toBe(false);
    expect(data.triage).toBeNull();

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("AI triage unavailable in this deployment");
    // The button must NOT be offered when pressing it could only fail.
    expect(html).not.toContain('data-testid="ai-triage-run"');
    expect(html).not.toContain('name="organizerScore"');
    expect(html).not.toContain("Save your score");
  });

  it("must-not-fire: a seeded row still renders when the binding is absent", async () => {
    // The judged-demo path. A deployment with no Workers AI must still show
    // the pre-computed opinion rather than hiding it behind the unavailable
    // banner — otherwise the seed is invisible exactly where it matters.
    await insertTriage(scored);
    const data = await detail(scored);
    expect(data.aiAvailable).toBe(false);

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("AI-generated (");
    // The opinion itself is NOT replaced by the unavailable banner — that is
    // the judged-demo guarantee, and the thing this test exists for.
    expect(html).toContain("Lean accept");
    // ...and "Run again" is present but disabled, so the state reads as
    // intentional rather than as a dead control.
    //
    // ⚠️ Assert the ATTRIBUTE, not the substring "disabled": `buttonClass()`
    // puts `disabled:cursor-not-allowed disabled:opacity-50` in every button's
    // class, so `/ai-triage-rerun"[^>]*disabled/` matched the Tailwind token
    // and stayed green when the attribute was deleted. Mutation control M2
    // caught it. `disabled=""` is what React emits for the real attribute.
    expect(html).toContain('data-testid="ai-triage-rerun"');
    expect(html).toMatch(/data-testid="ai-triage-rerun"[^>]*\sdisabled=""/);
    expect(html).toMatch(/data-testid="ai-triage-dismiss"[^>]*\sdisabled=""/);
    const organizerInput = html.match(/<input[^>]*name="organizerScore"[^>]*>/)?.[0];
    expect(organizerInput).toBeDefined();
    expect(organizerInput).not.toContain("disabled=");
  });

  it("must-fire: the disabled 'Run again' explains itself instead of just greying out", async () => {
    /*
     * The state a judge actually meets: the seeded demo, deployed without a
     * Workers AI binding. The explanation used to render only in the
     * `triage === null` branch, so this exact combination showed a dead control
     * and no reason for it. `aria-describedby` ties the sentence to the button
     * rather than leaving it merely nearby.
     */
    await insertTriage(scored);
    const data = await detail(scored);
    expect(data.aiAvailable).toBe(false);
    expect(data.triage).not.toBeNull();

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("AI triage unavailable in this deployment");
    expect(html).toContain("cannot be refreshed");
    expect(html).toMatch(
      /data-testid="ai-triage-rerun"[^>]*aria-describedby="ai-triage-unavailable-note"/,
    );
    expect(html).toContain('id="ai-triage-unavailable-note"');
    // Exactly one note per card — the empty-state branch must not render a
    // second copy now that the note is hoisted out of it.
    expect(html.match(/data-testid="ai-triage-unavailable"/g) ?? []).toHaveLength(1);
  });

  it("must-not-fire: with a binding, nothing on the card claims to be unavailable", async () => {
    // The complement. If the note rendered unconditionally, every assertion
    // above would still pass and the message would be a lie on a working
    // deployment.
    await seed({ AI: fakeAi(GOOD_REPLY) });
    await insertTriage(scored);
    const data = await detail(scored);
    expect(data.aiAvailable).toBe(true);

    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).not.toContain("AI triage unavailable in this deployment");
    expect(html).not.toContain("ai-triage-unavailable-note");
    expect(html).not.toMatch(/data-testid="ai-triage-rerun"[^>]*\sdisabled=""/);
    expect(html).toContain('data-testid="ai-triage-dismiss"');
    expect(html).not.toMatch(/data-testid="ai-triage-dismiss"[^>]*\sdisabled=""/);
  });
});

/* ──────────────────────────────────── authz ───────────────────────────── */

describe("an organizer can record a separate numeric read", () => {
  beforeEach(() => seed());

  it("must-fire: a valid score persists attribution and renders beside the AI score", async () => {
    await insertTriage(scored);

    const response = await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "4",
      organizerNote: "Strong topic\nneeds a tighter ending.",
      tab: "pending",
    });
    expect((response as Response).status).toBe(302);

    const rows = await ctx.db
      .select()
      .from(aiTriage)
      .where(and(eq(aiTriage.eventId, fixture.eventId), eq(aiTriage.sessionId, scored)));
    expect(rows).toHaveLength(1);
    expect(rows[0].organizerScore).toBe(4);
    expect(rows[0].organizerNote).toBe("Strong topic needs a tighter ending.");
    expect(rows[0].organizerScoredById).toBe(fixture.adminId);
    expect(rows[0].organizerScoredAt).toBeInstanceOf(Date);

    const data = await detail(scored);
    expect(data.triage?.organizerScore).toBe(4);
    expect(data.triage?.organizerNote).toBe("Strong topic needs a tighter ending.");
    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain('data-testid="organizer-score"');
    expect(html).toContain("Organizer: 4/5");
    expect(html).toContain('name="organizerScore"');
    expect(html).toContain('name="organizerNote"');
  });

  it("must-fire: an empty organizer note is normalized to null", async () => {
    await insertTriage(scored, { organizerNote: "old note" });

    await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "3",
      organizerNote: "  \n\t  ",
      tab: "pending",
    });

    const row = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(row?.organizerScore).toBe(3);
    expect(row?.organizerNote).toBeNull();
  });

  it("must-not-fire: organizer note content beyond 200 characters is not persisted", async () => {
    await insertTriage(scored);
    const longNote = "x".repeat(205);

    await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "3",
      organizerNote: longNote,
      tab: "pending",
    });

    const row = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(row?.organizerNote).toBe("x".repeat(200));
    expect(row?.organizerNote).not.toContain("x".repeat(201));
  });

  it.each(["0", "6", "-1", "not-a-number"])(
    "must-not-fire: invalid score %s is rejected without an organizer write",
    async (organizerScore) => {
      await insertTriage(scored);

      const result = await post(scored, {
        intent: "save-organizer-score",
        organizerScore,
        organizerNote: "This must not land.",
        tab: "pending",
      });
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain("1 to 5");

      const row = await ctx.db.query.aiTriage.findFirst({
        where: eq(aiTriage.sessionId, scored),
      });
      expect(row?.organizerScore).toBeNull();
      expect(row?.organizerNote).toBeNull();
      expect(row?.organizerScoredById).toBeNull();
      expect(row?.organizerScoredAt).toBeNull();
      const html = renderToStaticMarkup(<SubmissionDetailView {...(await detail(scored))} />);
      expect(html).not.toContain('data-testid="organizer-score"');
    },
  );

  it("must-not-fire: saving before AI triage creates no row", async () => {
    const result = await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "4",
      organizerNote: "No model row yet.",
      tab: "pending",
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Run AI triage");
    expect(await triageRowCount()).toBe(0);
  });

  it("must-not-fire: an organizer score changes no review, aggregate, CSV, or status", async () => {
    await insertTriage(scored);
    const beforeRows = await listRows();
    const beforeReviews = await ctx.db.select().from(reviews);
    const beforeCsv = await csvText();
    const scoreSortRequest = await signedInGet(
      "https://x.test/admin/submissions?tab=pending&sort=score-desc",
      fixture.adminId,
    );
    const beforeScoreOrder = (await listLoader(asListArgs(scoreSortRequest))).rows.map(
      (row) => row.id,
    );
    const beforeSession = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, scored),
    });
    expect(beforeRows.find((row) => row.id === scored)?.aggregateScore).toBeCloseTo(11 / 3, 5);
    expect(beforeReviews).toHaveLength(1);
    expect(beforeSession?.status).toBe("pending");

    await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "5",
      organizerNote: "My independent read.",
      tab: "pending",
    });

    const afterRows = await listRows();
    const afterReviews = await ctx.db.select().from(reviews);
    const afterSession = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, scored),
    });
    expect(afterRows.map((row) => [row.id, row.reviewCount, row.aggregateScore])).toEqual(
      beforeRows.map((row) => [row.id, row.reviewCount, row.aggregateScore]),
    );
    expect(afterReviews).toEqual(beforeReviews);
    expect(await csvText()).toBe(beforeCsv);
    expect((await listLoader(asListArgs(scoreSortRequest))).rows.map((row) => row.id)).toEqual(
      beforeScoreOrder,
    );
    expect(afterSession?.status).toBe(beforeSession?.status);
  });

  /*
   * Reconciliation with #173 (trifix): `loadTriage` already hides the whole
   * triage section — this control included — for a claimed or soft-dismissed
   * row (`row.status === "claimed"` / `dismissedAt` set both make it return
   * null). `saveOrganizerScore`'s WHERE clause mirrors that at the write
   * layer, so a direct POST that skips the UI cannot reach either row either
   * — the same "invisible row is not a scoreable row" invariant, enforced
   * twice rather than trusted from the read side alone.
   */
  it("must-not-fire: a claimed row (in-flight bulk reservation) refuses an organizer score", async () => {
    await insertTriage(scored, { status: "claimed", score: null, recommendation: null });

    const result = await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "4",
      organizerNote: "Should not land.",
      tab: "pending",
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Run AI triage");

    const row = await ctx.db.query.aiTriage.findFirst({ where: eq(aiTriage.sessionId, scored) });
    expect(row?.organizerScore).toBeNull();
    expect(row?.status).toBe("claimed");
    const html = renderToStaticMarkup(<SubmissionDetailView {...(await detail(scored))} />);
    expect(html).not.toContain('name="organizerScore"');
  });

  it("must-not-fire: a soft-dismissed row refuses an organizer score", async () => {
    await insertTriage(scored, { dismissedAt: new Date("2026-08-13T00:00:00Z") });

    const result = await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "4",
      organizerNote: "Should not land.",
      tab: "pending",
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Run AI triage");

    const row = await ctx.db.query.aiTriage.findFirst({ where: eq(aiTriage.sessionId, scored) });
    expect(row?.organizerScore).toBeNull();
    expect(row?.dismissedAt).toBeInstanceOf(Date);
    const html = renderToStaticMarkup(<SubmissionDetailView {...(await detail(scored))} />);
    expect(html).not.toContain('name="organizerScore"');
  });

  it("must-fire: an organizer score still saves on an ordinary ok row (not claimed, not dismissed)", async () => {
    await insertTriage(scored);

    const result = await post(scored, {
      intent: "save-organizer-score",
      organizerScore: "4",
      organizerNote: "Should land.",
      tab: "pending",
    });
    expect((result as Response).status).toBe(302);

    const row = await ctx.db.query.aiTriage.findFirst({ where: eq(aiTriage.sessionId, scored) });
    expect(row?.organizerScore).toBe(4);
  });
});

describe("only an admin can save an organizer score", () => {
  beforeEach(() => seed());

  it("must-not-fire: a speaker POSTing save-organizer-score gets 403 and writes nothing", async () => {
    await insertTriage(scored);
    const response = await post(
      scored,
      {
        intent: "save-organizer-score",
        organizerScore: "4",
        organizerNote: "Speaker-authored attempt.",
        tab: "pending",
      },
      fixture.speakerIds[0],
    ).catch((thrown: unknown) => thrown);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    const row = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(row?.organizerScore).toBeNull();
    expect(row?.organizerNote).toBeNull();
    expect(row?.organizerScoredById).toBeNull();
    expect(row?.organizerScoredAt).toBeNull();
  });
});

describe("only an admin can spend inference", () => {
  beforeEach(() => seed({ AI: fakeAi(GOOD_REPLY) }));

  it("must-not-fire: a speaker POSTing run-ai-triage gets 403 and writes nothing", async () => {
    const response = await post(
      scored,
      { intent: "run-ai-triage", tab: "pending" },
      fixture.speakerIds[0],
    ).catch((thrown: unknown) => thrown);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    expect(await triageRowCount()).toBe(0);
  });

  it("must-not-fire: an anonymous POST is bounced to login and writes nothing", async () => {
    const request = new Request(`https://x.test/admin/submissions/${scored}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "run-ai-triage", tab: "pending" }).toString(),
    });
    const thrown = await action(asActionArgs(request, scored)).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toContain("/login");
    expect(await triageRowCount()).toBe(0);
  });

  it("must-not-fire: a speaker cannot dismiss an admin's triage row either", async () => {
    await insertTriage(scored);
    const response = await post(
      scored,
      { intent: "dismiss-ai-triage", tab: "pending" },
      fixture.speakerIds[0],
    ).catch((thrown: unknown) => thrown);

    expect((response as Response).status).toBe(403);
    expect(await triageRowCount()).toBe(1);
  });

  it("must-fire: the admin's run writes exactly one row from the model's answer", async () => {
    const response = await post(scored, { intent: "run-ai-triage", tab: "pending" });
    expect((response as Response).status).toBe(302);

    const rows = await ctx.db.select().from(aiTriage).where(eq(aiTriage.sessionId, scored));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].score).toBe(4);
    expect(rows[0].recommendation).toBe("maybe");
    expect(rows[0].model).toBe(AI_TRIAGE_MODEL);
    expect(rows[0].requestedById).toBe(fixture.adminId);
  });
});

/* ─────────────────────────── the write path's blast radius ────────────── */

describe("triage changes nothing but the triage row", () => {
  beforeEach(() => seed({ AI: fakeAi(GOOD_REPLY) }));

  it("must-not-fire: running triage does not move the submission's status", async () => {
    const before = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, scored) });
    await post(scored, { intent: "run-ai-triage", tab: "pending" });
    const after = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, scored) });

    expect(before?.status).toBe("pending"); // control
    expect(after?.status).toBe("pending");
  });

  it("must-not-fire: running triage writes no `reviews` row", async () => {
    const before = await ctx.db.select().from(reviews);
    await post(scored, { intent: "run-ai-triage", tab: "pending" });
    const after = await ctx.db.select().from(reviews);

    expect(before).toHaveLength(1); // control: the human review exists
    expect(after).toHaveLength(1);
    expect(after[0].isAiSuggested).toBe(false);
  });

  it("must-fire: a malformed model answer is STORED as failed, not dropped", async () => {
    ctx.close();
    await seed({ AI: fakeAi("I'm sorry, I can't help with that.") });

    const response = await post(scored, { intent: "run-ai-triage", tab: "pending" });
    expect((response as Response).status).toBe(302);

    const rows = await ctx.db.select().from(aiTriage).where(eq(aiTriage.sessionId, scored));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].score).toBeNull();
    expect(rows[0].reasoning).toContain("I'm sorry");

    // ...and it renders as a failure a human can act on.
    const html = renderToStaticMarkup(<SubmissionDetailView {...(await detail(scored))} />);
    expect(html).toContain("not in a form we could read");
  });

  it("must-fire: Run again clears a dismissal and makes the replacement visible", async () => {
    await insertTriage(scored);
    expect(await triageRowCount()).toBe(1);

    await post(scored, { intent: "dismiss-ai-triage", tab: "pending" });
    const dismissed = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(dismissed?.dismissedAt).toBeInstanceOf(Date);
    expect((await detail(scored)).triage).toBeNull();

    await post(scored, { intent: "run-ai-triage", tab: "pending" });
    const rows = await ctx.db.select().from(aiTriage).where(eq(aiTriage.sessionId, scored));
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(4); // the NEW answer, not the seeded 5
    expect(rows[0].dismissedAt).toBeNull();
    expect((await detail(scored)).triage?.score).toBe(4);
  });

  it("must-fire: Dismiss removes this row; must-not-fire: it leaves other rows alone", async () => {
    const other = fixture.abstractIds[4];
    await insertTriage(scored);
    await insertTriage(other);
    expect(await triageRowCount()).toBe(2);

    await post(scored, { intent: "dismiss-ai-triage", tab: "pending" });

    const rows = await ctx.db.select().from(aiTriage);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.sessionId === scored)?.dismissedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.sessionId === other)?.dismissedAt).toBeNull();
    expect((await detail(scored)).triage).toBeNull();
    expect((await detail(other)).triage?.status).toBe("ok");
  });

  it("must-not-fire: dismissing a row an in-flight bulk claim owns is refused, and the claim survives untouched", async () => {
    // A "claimed" row is a bulk request's reservation, mid-flight — its score,
    // recommendation and reasoning are still null, waiting on the model.
    // `storeTriageOutcome`'s upsert clears `dismissedAt` on every completion
    // (see "Run again clears a dismissal" above), so if dismiss set it here,
    // the claim's own resolution would silently undo the dismissal moments
    // later. Refusing while claimed closes that race instead of racing it.
    await ctx.db.insert(aiTriage).values({
      id: crypto.randomUUID(),
      eventId: fixture.eventId,
      sessionId: scored,
      score: null,
      recommendation: null,
      reasoning: null,
      model: AI_TRIAGE_MODEL,
      status: "claimed",
      requestedById: fixture.adminId,
    });
    const before = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(before?.status).toBe("claimed"); // control: the claim really is there

    const result = await post(scored, { intent: "dismiss-ai-triage", tab: "pending" });

    expect(result).toEqual({
      ok: false,
      error:
        "This AI triage opinion is still being generated by a bulk run — try dismissing it again in a moment.",
    });
    const after = await ctx.db.query.aiTriage.findFirst({
      where: eq(aiTriage.sessionId, scored),
    });
    expect(after).toEqual(before);
    expect(after?.dismissedAt).toBeNull();
  });

  it("must-fire: single-item triage sends the current rubric criterion names", async () => {
    ctx.close();
    const ai = fakeAi(GOOD_REPLY);
    await seed({ AI: ai });

    await post(scored, { intent: "run-ai-triage", tab: "pending" });

    expect(ai.calls).toHaveLength(1);
    const messages = ai.calls[0].inputs.messages as { role: string; content: string }[];
    expect(messages[1].content).toContain("This committee scores on:");
    expect(messages[1].content).toContain("Originality");
    expect(messages[1].content).toContain("Relevance");
  });

  it("must-not-fire: single-item triage without a review round keeps the generic prompt", async () => {
    ctx.close();
    const ai = fakeAi(GOOD_REPLY);
    await seed({ AI: ai });
    await ctx.db.delete(reviewRounds);

    const response = await post(scored, { intent: "run-ai-triage", tab: "pending" });

    expect((response as Response).status).toBe(302);
    expect(ai.calls).toHaveLength(1);
    const messages = ai.calls[0].inputs.messages as { role: string; content: string }[];
    expect(messages[1].content).not.toContain("This committee scores on:");
  });

  it("must-not-fire: run-ai-triage refuses a soft-deleted abstract and writes nothing", async () => {
    const ai = fakeAi(GOOD_REPLY);
    ctx.close();
    await seed({ AI: ai });
    await ctx.db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(eq(sessions.id, scored));

    const result = await post(scored, { intent: "run-ai-triage", tab: "pending" });

    expect(result).toEqual({ ok: false, error: "That abstract no longer exists." });
    expect(ai.calls).toHaveLength(0);
    expect(await triageRowCount()).toBe(0);
  });

  it("must-not-fire: dismiss-ai-triage refuses a soft-deleted abstract and leaves its row untouched", async () => {
    const ai = fakeAi(GOOD_REPLY);
    ctx.close();
    await seed({ AI: ai });
    await insertTriage(scored);
    await ctx.db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(eq(sessions.id, scored));
    const before = await ctx.db.select().from(aiTriage).where(eq(aiTriage.sessionId, scored));

    const result = await post(scored, { intent: "dismiss-ai-triage", tab: "pending" });

    expect(result).toEqual({ ok: false, error: "That abstract no longer exists." });
    expect(ai.calls).toHaveLength(0);
    expect(await ctx.db.select().from(aiTriage).where(eq(aiTriage.sessionId, scored))).toEqual(
      before,
    );
  });
});

/* ────────────────────── the bindingless deployment, on the write path ── */

describe("no binding is a visible refusal, not a crash", () => {
  beforeEach(() => seed());

  it("must-not-fire: run-ai-triage with no binding writes nothing and says why", async () => {
    const result = await post(scored, { intent: "run-ai-triage", tab: "pending" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("unavailable in this deployment");
    expect(await triageRowCount()).toBe(0);
  });

  it("must-not-fire: dismiss with no binding is refused, and the row survives untouched", async () => {
    // A binding-less deployment cannot regenerate its seeded/pre-computed
    // opinion. The UI therefore disables Dismiss and says so; the server must
    // back that promise instead of leaving the disabled control as decoration.
    await insertTriage(scored);
    const before = await ctx.db
      .select()
      .from(aiTriage)
      .where(and(eq(aiTriage.eventId, fixture.eventId), eq(aiTriage.sessionId, scored)));

    const result = await post(scored, { intent: "dismiss-ai-triage", tab: "pending" });
    expect(result).toEqual({
      ok: false,
      error: "AI triage unavailable in this deployment — no Workers AI binding is configured.",
    });
    expect(
      await ctx.db
        .select()
        .from(aiTriage)
        .where(and(eq(aiTriage.eventId, fixture.eventId), eq(aiTriage.sessionId, scored))),
    ).toEqual(before);
  });
});
