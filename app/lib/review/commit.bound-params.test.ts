/**
 * The queue commit that broke on deployed D1 but passed every local test.
 *
 * `POST /admin/submissions?confirm=commit` with 4 accepts + 3 declines failed
 * with `D1_ERROR: too many SQL variables at offset 1103` while the DB-backed
 * tests stayed green: the unit-test SQLite stand-in (app/test/d1.ts) inherits
 * node:sqlite's ~32k parameter ceiling, so a statement D1 rejects at 100 runs
 * fine in Node. Nothing that asserts on ROWS can catch that class of bug.
 *
 * So this asserts on the WIRE instead — the bound-parameter count of every
 * statement the commit hands to the D1 binding. On the unfixed code the `tasks`
 * insert measures 110 parameters and this goes red; the row-outcome checks
 * below it stay green either way, which is the point of having both.
 */
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOUND_PARAM_BUDGET, MAX_BOUND_PARAMS } from "~/db/client.server";
import { sessions, sessionParticipants, tasks } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import { commitQueues } from "./commit.server";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

interface SentStatement {
  sql: string;
  params: number;
}

/**
 * Record what actually reaches the binding. Wrapping D1 rather than drizzle is
 * deliberate: the parameter list is only final after drizzle has rendered the
 * statement, and rendering is where the surprise lives.
 */
function recordBatches(): { calls: SentStatement[][] } {
  const binding = env.DB as { batch: (statements: unknown[]) => Promise<unknown> };
  const original = binding.batch.bind(binding);
  const calls: SentStatement[][] = [];

  binding.batch = async (statements: unknown[]) => {
    calls.push(
      statements.map((statement) => {
        const sent = statement as { sql: string; params?: unknown[] };
        return { sql: sent.sql, params: sent.params?.length ?? 0 };
      }),
    );
    return original(statements);
  };

  return { calls };
}

/** The deployed repro: 4 accepts + 3 declines in one commit. */
async function queueSevenDecisions() {
  const accept = [0, 1, 2, 3].map((index) => fixture.abstractIds[index]);
  const decline = [4, 5, 6].map((index) => fixture.abstractIds[index]);
  await ctx.db
    .update(sessions)
    .set({ status: "accept_queue" })
    .where(inArray(sessions.id, accept));
  await ctx.db
    .update(sessions)
    .set({ status: "decline_queue" })
    .where(inArray(sessions.id, decline));
  return { accept, decline };
}

describe("commitQueues bound parameters", () => {
  it("must fire: no statement in a 7-decision commit exceeds the bound-param budget", async () => {
    await queueSevenDecisions();
    const recorder = recordBatches();

    const result = await commitQueues(fixture.eventId);

    // Guard the guard: a commit that wrote nothing would pass a "nothing is too
    // wide" assertion vacuously. This is the shape that actually blew the cap —
    // 5 speakers across 4 accepted abstracts x 4 task templates.
    expect(result.accepted).toBe(4);
    expect(result.declined).toBe(3);
    expect(result.tasksCreated).toBe(20);

    const sent = recorder.calls.flat();
    expect(sent.length).toBeGreaterThan(0);

    const widest = Math.max(...sent.map((statement) => statement.params));
    const offenders = sent
      .filter((statement) => statement.params > BOUND_PARAM_BUDGET)
      .map((statement) => `${statement.params} params: ${statement.sql.slice(0, 80)}`);

    expect(offenders).toEqual([]);
    expect(widest).toBeLessThanOrEqual(BOUND_PARAM_BUDGET);
    // The budget only matters because D1 rejects anything past this.
    expect(widest).toBeLessThan(MAX_BOUND_PARAMS);
  });

  it("must fire: the whole commit is ONE atomic batch, so it cannot half-apply", async () => {
    await queueSevenDecisions();
    const recorder = recordBatches();

    await commitQueues(fixture.eventId);

    expect(recorder.calls.length).toBe(1);
  });

  it("must not fire: chunking does not change the rows a commit produces", async () => {
    const { accept, decline } = await queueSevenDecisions();

    const result = await commitQueues(fixture.eventId);

    // Every accepted abstract is composed into exactly one program session.
    const abstracts = await ctx.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, accept));
    expect(abstracts).toHaveLength(4);
    for (const abstract of abstracts) {
      expect(abstract.status).toBe("accepted");
      expect(abstract.composedIntoSessionId).toBeTruthy();
    }

    const programIds = abstracts.map((row) => row.composedIntoSessionId!);
    expect(new Set(programIds).size).toBe(4);

    const programmes = await ctx.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, programIds));
    expect(programmes).toHaveLength(4);
    for (const programme of programmes) {
      expect(programme.isAbstract).toBe(false);
      expect(programme.status).toBe("accepted");
      // Unscheduled on purpose — the agenda builder places it.
      expect(programme.startsAt).toBeNull();
    }

    // Participants carried across: abstract 0 is the two-speaker one, so 5 links.
    const carried = await ctx.db
      .select()
      .from(sessionParticipants)
      .where(inArray(sessionParticipants.sessionId, programIds));
    expect(carried).toHaveLength(5);

    // 5 carried speakers x 4 task templates, none duplicated.
    const created = await ctx.db
      .select()
      .from(tasks)
      .where(inArray(tasks.sessionId, programIds));
    expect(created).toHaveLength(20);
    expect(result.tasksCreated).toBe(20);
    const keys = created.map((row) => `${row.templateId}|${row.personId}|${row.sessionId}`);
    expect(new Set(keys).size).toBe(20);
    for (const task of created) {
      expect(task.status).toBe("pending");
      // The scalar default that made a 10-key row cost 11 bound parameters.
      expect(task.kind).toBe("manual");
    }

    // Declines flipped, and nothing else did.
    const declined = await ctx.db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, decline));
    expect(declined.map((row) => row.status)).toEqual(["declined", "declined", "declined"]);
    expect(result.untouched).toBe(1);
  });

  it("must not fire: a commit with nothing queued writes no batch at all", async () => {
    const recorder = recordBatches();

    const result = await commitQueues(fixture.eventId);

    expect(result.accepted).toBe(1); // the fixture's single queued accept
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0].every((statement) => statement.params <= BOUND_PARAM_BUDGET)).toBe(
      true,
    );
  });
});
