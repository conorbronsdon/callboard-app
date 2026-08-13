/**
 * The two statements on the Files lane that exceeded D1's bound-parameter cap.
 *
 * Both were reported by a cross-family review and neither was visible to the
 * suite, for the reason `app/lib/review/commit.bound-params.test.ts` already
 * wrote down after the queue commit shipped the same class of bug:
 *
 *   "the unit-test SQLite stand-in (app/test/d1.ts) inherits node:sqlite's
 *    ~32k parameter ceiling, so a statement D1 rejects at 100 runs fine in
 *    Node. Nothing that asserts on ROWS can catch that class of bug."
 *
 * Every other test in this lane asserts on rows. So this file asserts on the
 * WIRE: it wraps the D1 binding's `prepare` and records what each statement
 * actually binds. `batch` is wrapped too — the commit test only needed `batch`
 * because a commit is a batch; a loader's `select` goes through `prepare`.
 *
 * ── Why the volumes below are what they are ──
 * `admin.files.tsx` renders up to LIBRARY_ROW_LIMIT = 500 rows and its comment
 * fetch bound ONE parameter per distinct deliverable, so ~101 chains took the
 * whole page down with `D1_ERROR: too many SQL variables`. The download route
 * bound one per ticked file plus the event id, so 100 ticks was 101 parameters
 * and failed before a single R2 read. 120 is used here: comfortably past the
 * 100 cap, cheap to seed, and it makes both tests go RED on the unchunked code
 * while staying green on the fix. Measured by reverting each `chunkForBind`
 * call to a single-element array: the loader's comment fetch reports
 * `120 params: select … from "upload_comments" …` and the download's lookup
 * reports 121 (120 ids plus the event id). Both are past MAX_BOUND_PARAMS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOUND_PARAM_BUDGET, MAX_BOUND_PARAMS } from "~/db/client.server";
import { uploadComments, uploads } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import { action as downloadAction } from "./admin.files.download";
import { loader } from "./admin.files";

type LoaderArgs = Parameters<typeof loader>[0];
type DownloadArgs = Parameters<typeof downloadAction>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  env.FILES = {
    async put() {},
    async get() {
      return null;
    },
    async delete() {},
  };
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

interface SentStatement {
  sql: string;
  params: number;
}

/**
 * Record what actually reaches the binding.
 *
 * Wrapping the D1 binding rather than drizzle is deliberate and inherited from
 * the commit test: the parameter list is only final after drizzle has rendered
 * the statement, and rendering is where the surprise lives. `bind()` is where
 * a prepared statement receives its parameters, so the wrapper has to follow
 * the statement object rather than read the `prepare` call alone.
 */
function recordStatements(): { sent: SentStatement[] } {
  const binding = env.DB as {
    prepare: (sql: string) => unknown;
    batch: (statements: unknown[]) => Promise<unknown>;
  };
  const originalPrepare = binding.prepare.bind(binding);
  const originalBatch = binding.batch.bind(binding);
  const sent: SentStatement[] = [];

  binding.prepare = (sql: string) => {
    const statement = originalPrepare(sql) as { bind: (...args: unknown[]) => unknown };
    const originalBind = statement.bind.bind(statement);
    // A statement with no parameters is never `bind()`-ed; record it now so the
    // recorder cannot under-count, and correct it when bind supplies the real
    // list. (`prepare` returns a fresh object per call, so there is no leak.)
    const entry: SentStatement = { sql, params: 0 };
    sent.push(entry);
    statement.bind = (...params: unknown[]) => {
      entry.params = params.length;
      return originalBind(...params);
    };
    return statement;
  };
  binding.batch = async (statements: unknown[]) => originalBatch(statements);

  return { sent };
}

/** `count` distinct deliverables, each its own chain, each with a comment. */
async function seedDeliverables(count: number): Promise<string[]> {
  const ids: string[] = [];
  const uploadRows = [];
  const commentRows = [];
  for (let i = 0; i < count; i += 1) {
    const id = `44000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    ids.push(id);
    uploadRows.push({
      id,
      eventId: fixture.eventId,
      ownerType: "person" as const,
      ownerId: fixture.speakerIds[0],
      purpose: "document" as const,
      key: `${fixture.eventId}/person/${fixture.speakerIds[0]}/document/${id}-deck.pdf`,
      filename: `deck-${i}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 100,
      uploadedById: fixture.speakerIds[0],
    });
    commentRows.push({
      id: `45000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      uploadId: id,
      authorId: fixture.adminId,
      authorName: "Ada Organiser",
      body: `note ${i}`,
    });
  }
  // Inserted in small slices for the same reason the production code chunks:
  // the seeding itself would otherwise be the widest statement in the test.
  for (let i = 0; i < uploadRows.length; i += 5) {
    await ctx.db.insert(uploads).values(uploadRows.slice(i, i + 5));
  }
  for (let i = 0; i < commentRows.length; i += 5) {
    await ctx.db.insert(uploadComments).values(commentRows.slice(i, i + 5));
  }
  return ids;
}

/** The offenders, formatted so a failure names the statement. */
function offenders(sent: SentStatement[], limit: number): string[] {
  return sent
    .filter((statement) => statement.params > limit)
    .map((statement) => `${statement.params} params: ${statement.sql.slice(0, 90)}`);
}

const DELIVERABLES = 120;

describe("/admin/files loader bound parameters", () => {
  it("MUST FIRE: no statement exceeds D1's cap with 120 deliverables on the page", async () => {
    const ids = await seedDeliverables(DELIVERABLES);
    const recorder = recordStatements();

    const data = await loader({
      request: await signedInGet("https://x.test/admin/files", fixture.adminId),
      params: {},
      context: {},
    } as unknown as LoaderArgs);

    /*
     * Guard the guard. A loader that returned early — no event, an auth throw,
     * a query that read nothing — would satisfy "no statement is too wide"
     * vacuously. These pin the shape that actually blew the cap: every seeded
     * deliverable rendered, each with its own comment thread.
     */
    expect(data.chains.length).toBeGreaterThanOrEqual(DELIVERABLES);
    expect(data.chains.filter((chain) => chain.comments.length > 0).length).toBe(DELIVERABLES);
    expect(ids).toHaveLength(DELIVERABLES);

    const widest = Math.max(...recorder.sent.map((statement) => statement.params));
    expect(offenders(recorder.sent, MAX_BOUND_PARAMS - 1)).toEqual([]);
    // The hard rule: D1 rejects anything at or past MAX_BOUND_PARAMS.
    expect(widest).toBeLessThan(MAX_BOUND_PARAMS);

    /*
     * And prove the test could have failed. The comment fetch is one parameter
     * per deliverable, so a statement carrying all 120 would be the widest
     * thing here. The recorder has to have SEEN a wide statement for the
     * assertion above to mean anything — this pins that the IN list really was
     * split and really did run, rather than the page having quietly stopped
     * fetching comments at all.
     */
    const inLists = recorder.sent.filter((statement) =>
      /from "?upload_comments"?/i.test(statement.sql),
    );
    expect(inLists.length).toBeGreaterThan(1); // chunked: more than one statement
    expect(inLists.reduce((sum, statement) => sum + statement.params, 0)).toBe(DELIVERABLES);
    expect(Math.max(...inLists.map((statement) => statement.params))).toBeLessThanOrEqual(
      BOUND_PARAM_BUDGET,
    );
  });
});

describe("/admin/files/download bound parameters", () => {
  it("MUST FIRE: ticking 120 files stays inside D1's cap", async () => {
    const ids = await seedDeliverables(DELIVERABLES);
    const recorder = recordStatements();

    const response = (await downloadAction({
      request: new Request("https://x.test/admin/files/download", {
        method: "POST",
        headers: {
          cookie:
            (
              await signedInGet("https://x.test/admin/files/download", fixture.adminId)
            ).headers.get("cookie") ?? "",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(ids.map((id) => ["uploadIds", id])).toString(),
      }),
      params: {},
      context: {},
    } as unknown as DownloadArgs)) as Response;

    /*
     * Guard the guard. The R2 stub returns null for every key, so this run ends
     * at the "none of those files are still in storage" refusal — AFTER the
     * lookup that was the bug, which is the only part being measured. A
     * selection that had been rejected earlier (empty, foreign, over the cap)
     * would never have issued the wide statement at all.
     */
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("location")!, "https://x.test").searchParams.get("download"),
    ).toBe("missing");

    const widest = Math.max(...recorder.sent.map((statement) => statement.params));
    expect(offenders(recorder.sent, MAX_BOUND_PARAMS - 1)).toEqual([]);
    expect(widest).toBeLessThan(MAX_BOUND_PARAMS);

    const lookups = recorder.sent.filter((statement) => /from "?uploads"?/i.test(statement.sql));
    expect(lookups.length).toBeGreaterThan(1); // chunked
    // One event id rides along with each chunk's IN list, so the total is
    // 120 ids + one event id per statement.
    expect(lookups.reduce((sum, statement) => sum + statement.params, 0)).toBe(
      DELIVERABLES + lookups.length,
    );
    /*
     * The IN list itself stays inside BOUND_PARAM_BUDGET. The extra 10
     * parameters between the budget and the cap exist precisely so riders like
     * this statement's `event_id` have somewhere to go — see the comment on
     * BOUND_PARAM_BUDGET — so the statement measuring 91 is by design, and
     * asserting the whole statement against 90 would be asserting the wrong
     * number.
     */
    expect(Math.max(...lookups.map((statement) => statement.params - 1))).toBeLessThanOrEqual(
      BOUND_PARAM_BUDGET,
    );
  });
});
