/**
 * Bulk AI triage, one bounded batch per request.
 *
 * The old bulk button scored up to twelve abstracts inside a single action and
 * returned after roughly twenty seconds of nothing at all — a judge timed 21.7s
 * against a button that never changed. The work is now split: each POST scores
 * `AI_TRIAGE_BULK_BATCH` submissions and answers with `{ done, total }`, and
 * the client re-submits until the action answers with a redirect instead.
 *
 * WHAT THESE TESTS COVER, AND WHAT THEY DO NOT. The suite runs in `environment:
 * "node"` with no DOM, so the browser-side auto-continue (a `useFetcher` and an
 * effect in the route's default export) is NOT exercised here. What is
 * exercised is the protocol underneath it, driven exactly as a client drives
 * it — including the property that makes an auto-continuing client safe at all:
 * every response either advances `done` or is a redirect, so the loop cannot
 * run forever. The no-JS path is the same protocol with a human pressing
 * Continue, and its markup is asserted below.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiTriage, reviewRounds, reviews, sessions } from "~/db/schema";
import { AI_TRIAGE_BULK_BATCH, AI_TRIAGE_BULK_CAP } from "~/lib/review/ai-triage.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { AbstractsView, action, loader } from "./admin.submissions";

type ActionArgs = Parameters<typeof action>[0];
type LoaderArgs = Parameters<typeof loader>[0];
type ActionResult = Awaited<ReturnType<typeof action>>;
type TriageProgress = { done: number; total: number; scored: number; failed: number };

const ROUND = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const REPLY = '{"score":4,"recommendation":"accept","reasoning":"Concrete and well scoped."}';

let ctx: TestDbContext;
let fixture: DemoFixture;
let calls: { model: string; inputs: Record<string, unknown> }[];

function fakeAi() {
  calls = [];
  return {
    async run(model: string, inputs: Record<string, unknown>) {
      calls.push({ model, inputs });
      return { response: REPLY };
    },
  };
}

const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;
const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

/** Bring the event up to `count` pending, un-triaged abstracts. */
async function seedPending(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `ee${String(index).padStart(2, "0")}0000-e0e0-4e0e-8e0e-e0e0e0e0e0e0`,
    eventId: fixture.eventId,
    friendlyId: `ABS-9${index}`,
    title: `Pending abstract ${index}`,
    status: "pending" as const,
    isAbstract: true,
    createdAt: new Date(2026, 0, index + 1),
  }));
  // Park every seeded abstract out of `pending` so the count under test is
  // exactly the rows this helper inserted.
  await ctx.db.update(sessions).set({ status: "accepted" }).where(eq(sessions.isAbstract, true));
  await ctx.db.insert(sessions).values(rows);
}

async function post(fields: Record<string, string>): Promise<ActionResult> {
  return action(
    asActionArgs(
      await signedInPost("https://x.test/admin/submissions", fixture.adminId, {
        intent: "run-ai-triage-bulk",
        tab: "pending",
        ...fields,
      }),
    ),
  );
}

const progressOf = (result: ActionResult): TriageProgress => {
  expect(result instanceof Response).toBe(false);
  const triage = (result as { triage?: TriageProgress }).triage;
  if (!triage) throw new Error(`expected progress, got ${JSON.stringify(result)}`);
  return triage;
};

/** Drive the protocol the way the client does, and report every round. */
async function runToCompletion(limit = 20) {
  const rounds: TriageProgress[] = [];
  let fields: Record<string, string> = {};

  for (let guard = 0; guard < limit; guard += 1) {
    const result = await post(fields);
    if (result instanceof Response) return { rounds, final: result };
    const triage = progressOf(result);
    rounds.push(triage);
    fields = {
      done: String(triage.done),
      total: String(triage.total),
      scored: String(triage.scored),
      failed: String(triage.failed),
    };
  }
  throw new Error(`bulk triage did not finish within ${limit} requests`);
}

beforeEach(async () => {
  ctx = installTestDb({ AI: fakeAi() });
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.delete(reviewRounds);
  await ctx.db.insert(reviewRounds).values({
    id: ROUND,
    eventId: fixture.eventId,
    name: "Programme review",
    ordinal: 1,
    rubric: {
      criteria: [
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 2 },
        { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 1 },
      ],
    },
  });
});

afterEach(() => ctx.close());

describe("bulk triage progress", () => {
  it("MUST FIRE: twelve pending finish in three rounds of four, ending in a redirect", async () => {
    await seedPending(12);

    const { rounds, final } = await runToCompletion();

    expect(rounds).toEqual([
      { done: 4, total: 12, scored: 4, failed: 0 },
      { done: 8, total: 12, scored: 8, failed: 0 },
    ]);
    // The last round redirects rather than reporting progress, so the notice
    // an organizer already knows ("N scored, advisory only") is unchanged.
    expect(final.status).toBe(302);
    expect(final.headers.get("location")).toContain("ai=12");
    expect(final.headers.get("location")).toContain("aif=0");

    expect(calls.length).toBe(12);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(12);
    expect(AI_TRIAGE_BULK_BATCH).toBe(4);
  });

  it("MUST FIRE: each round scores exactly one batch, not the whole run", async () => {
    await seedPending(12);

    const first = progressOf(await post({}));
    expect(first).toEqual({ done: 4, total: 12, scored: 4, failed: 0 });
    // The proof that the request RETURNED early rather than finishing the work
    // quietly: only four inference calls have happened at this point.
    expect(calls.length).toBe(4);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(4);
  });

  it("MUST NOT FIRE: the run stops at the cap however many are pending", async () => {
    await seedPending(20);

    const { rounds, final } = await runToCompletion();

    expect(rounds.map((round) => round.done)).toEqual([4, 8]);
    expect(final.headers.get("location")).toContain(`ai=${AI_TRIAGE_BULK_CAP}`);
    expect(calls.length).toBe(AI_TRIAGE_BULK_CAP);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(AI_TRIAGE_BULK_CAP);
    // Eight are deliberately left un-triaged: pressing the button again picks
    // them up, and one press is still one bounded, billable run. All twenty
    // rows are still pending, because triage moves no status.
    const stillPending = await ctx.db.select().from(sessions).where(eq(sessions.status, "pending"));
    expect(stillPending.length).toBe(20);
  });

  it("MUST NOT FIRE: already-triaged abstracts are never scored twice", async () => {
    await seedPending(6);

    await runToCompletion();
    expect(calls.length).toBe(6);

    // A second press, and a stale continuation replayed from an old tab.
    const second = await runToCompletion();
    const replay = await post({ done: "0", total: "12", scored: "0", failed: "0" });

    expect(second.rounds).toEqual([]);
    expect(second.final.status).toBe(302);
    expect(replay instanceof Response).toBe(true);
    expect(calls.length).toBe(6);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(6);
  });

  it("MUST NOT FIRE: a client that lies about its progress cannot extend the run", async () => {
    await seedPending(20);

    // Claims a total of 999 and no work done. The cap still binds it.
    const rounds: TriageProgress[] = [];
    let fields: Record<string, string> = { done: "0", total: "999", scored: "0", failed: "0" };
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await post(fields);
      if (result instanceof Response) break;
      const triage = progressOf(result);
      rounds.push(triage);
      fields = { done: String(triage.done), total: "999", scored: "0", failed: "0" };
    }

    expect(rounds.every((round) => round.total === AI_TRIAGE_BULK_CAP)).toBe(true);
    expect(calls.length).toBe(AI_TRIAGE_BULK_CAP);
  });

  it("MUST NOT FIRE: a client that replays a stale cursor still cannot double-charge a row", async () => {
    /*
     * The adversarial case an honest-client test cannot reach: never advance
     * the cursor, just keep posting `done=0`. That is not an escalation — it is
     * the button being pressed again, which `main` allowed at twelve rows a
     * press rather than four — but two properties have to hold anyway. No
     * single request may exceed one batch, and no row may be scored twice,
     * which together make the run finite even for a client that never stops.
     */
    await seedPending(20);

    let requests = 0;
    for (let guard = 0; guard < 12; guard += 1) {
      const before = calls.length;
      const result = await post({ done: "0", total: "12", scored: "0", failed: "0" });
      requests += 1;
      expect(calls.length - before).toBeLessThanOrEqual(AI_TRIAGE_BULK_BATCH);
      if (result instanceof Response) break;
    }

    /*
     * Twenty rows at four a request is five requests, not six: the last one
     * scores its batch AND redirects, because with four rows left the planner
     * sets the run's total to four and `done` reaches it in the same request.
     * Every call scored a DIFFERENT row.
     */
    expect(requests).toBe(5);
    expect(calls.length).toBe(20);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(20);
  });

  it("MUST NOT FIRE: bulk triage still writes no review and moves no status", async () => {
    await seedPending(6);
    const reviewsBefore = await ctx.db.select().from(reviews);
    const statusesBefore = (await ctx.db.select().from(sessions)).map((row) => row.status);

    await runToCompletion();

    expect((await ctx.db.select().from(reviews)).length).toBe(reviewsBefore.length);
    expect((await ctx.db.select().from(sessions)).map((row) => row.status)).toEqual(statusesBefore);
  });

  it("MUST FIRE: the prompt carries the current round's criterion names", async () => {
    await seedPending(4);
    await post({});

    expect(calls.length).toBe(4);
    for (const call of calls) {
      const messages = call.inputs.messages as { role: string; content: string }[];
      expect(messages[1].content).toContain("This committee scores on:");
      expect(messages[1].content).toContain("Relevance");
      expect(messages[1].content).toContain("Technical depth");
    }
  });

  it("MUST NOT FIRE: no binding is still a refusal, not a batch of nothing", async () => {
    ctx.close();
    ctx = installTestDb();
    fixture = await seedDemoFixture(ctx.db);
    await seedPending(6);

    const result = await post({});

    expect(result instanceof Response).toBe(false);
    expect((result as { ok: boolean }).ok).toBe(false);
    expect((await ctx.db.select().from(aiTriage)).length).toBe(0);
  });

  it("MUST FIRE: without JavaScript the page offers the next batch as a button", async () => {
    await seedPending(12);
    const triage = progressOf(await post({}));
    const data = await loader(
      asLoaderArgs(await signedInGet("https://x.test/admin/submissions?tab=pending", fixture.adminId)),
    );
    const html = renderToStaticMarkup(
      <AbstractsView {...data} actionData={{ ok: true, triage }} />,
    );

    // The count an organizer reads, and the control that advances it.
    expect(html).toContain("Scoring 4 of 12");
    expect(html).toContain('name="done" value="4"');
    expect(html).toContain('name="total" value="12"');
    expect(html).toContain('name="scored" value="4"');
  });
});
