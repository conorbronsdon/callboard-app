/**
 * `/portal/tasks/:taskId` is the SECOND door into `storeUpload`.
 *
 * #85 capped `/api/upload`, correctly and with the caller-selectable scope
 * removed. It did not touch this route, where a `file` question on a portal
 * task reaches the same writer. `enforceRateLimit` appeared in exactly three
 * places in the repository and this was not one of them, so an authenticated
 * speaker could push bytes at R2 through the task form without limit —
 * rejected uploads leave no `uploads` row, so the storage quota did not cap the
 * attempts either.
 *
 * Every case asserts against the STORED bucket rows as well as the response, so
 * a limiter wired to the wrong scope, or to a per-request identifier, fails
 * here rather than looking green because a 429 arrived from somewhere.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forms, tasks } from "~/db/schema";
import { RATE_LIMIT_POLICIES } from "~/lib/rate-limit.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { env } from "~/test/workers-env";
import { seedDemoFixture, EVENT_ID, type DemoFixture } from "~/test/fixtures";

import { action } from "./portal.task";
import { action as apiUploadAction } from "./api.upload";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request, taskId: string) =>
  ({ request, params: { taskId }, context: {} }) as unknown as ActionArgs;

/** Minimal in-memory R2 stand-in; `storeUpload` only ever puts and deletes. */
function createTestBucket() {
  const objects = new Map<string, unknown>();
  return {
    objects,
    binding: {
      async put(key: string) {
        objects.set(key, {});
      },
      async get(key: string) {
        return objects.has(key) ? ({} as unknown) : null;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
}

const FORM_ID = "14000000-0000-4000-8000-000000000001";
const TASK_OF = (index: number) => `14000000-0000-4000-8000-00000000001${index}`;

let ctx: TestDbContext;
let fixture: DemoFixture;
let bucket: ReturnType<typeof createTestBucket>;

beforeEach(async () => {
  ctx = installTestDb();
  bucket = createTestBucket();
  env.FILES = bucket.binding;
  fixture = await seedDemoFixture(ctx.db);

  // A portal form with a file question, and one task per speaker pointing at
  // it. The seeded tasks are manual, so the upload branch is unreachable
  // without this — a flood test against a task that cannot take a file would
  // pass on the unfixed tree for the wrong reason.
  await ctx.db.insert(forms).values({
    id: FORM_ID,
    eventId: EVENT_ID,
    name: "Slide upload",
    target: "session",
    surface: "portal",
    status: "open",
    schema: {
      sectionTitle: "Your slides",
      questions: [{ key: "slides", label: "Slide deck", type: "file", filePurpose: "slides" }],
    },
    settings: { surface: "portal", type: "collect" },
  });
  await ctx.db.insert(tasks).values(
    [0, 1].map((index) => ({
      id: TASK_OF(index),
      eventId: EVENT_ID,
      personId: fixture.speakerIds[index],
      title: "Submit your slides",
      status: "pending" as const,
      formId: FORM_ID,
    })),
  );
});
afterEach(() => ctx.close());

/** One multipart task submission carrying a file. */
async function uploadToTask(personId: string, taskId: string): Promise<Response> {
  const body = new FormData();
  body.set("intent", "submit-form");
  body.set("slides", new File(["slide bytes"], "deck.txt", { type: "text/plain" }));

  const signed = await signedInGet(`https://x.test/portal/tasks/${taskId}`, personId);
  const request = new Request(signed.url, {
    method: "POST",
    headers: { cookie: signed.headers.get("cookie") as string },
    body,
  });

  try {
    await action(args(request, taskId));
    return new Response(null, { status: 200 });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Sorted by count, not by scope: two rows in one scope have no stable order. */
const buckets = () =>
  (
    ctx.sqlite
      .prepare("select scope, window_count from rate_limit_windows")
      .all() as { scope: string; window_count: number }[]
  ).sort((a, b) => b.window_count - a.window_count);

const uploadRowCount = () =>
  (ctx.sqlite.prepare("select count(*) as n from uploads").get() as { n: number }).n;

/**
 * `apiUpload` is a FIXED window (30/10min): `windowStart` snaps to wall-clock
 * :00/:10/:20/:30/:40/:50, and this route never threads an injectable `now`
 * down to `consumeRateLimit`. A run straddling one of those marks resets the
 * counter mid-flood, so the assertion that attempt `limit + 1` is refused
 * would go red on the wrong tree entirely. Same class of flake as
 * admin.reviews.provisioning.test.tsx's magic-link case; pin the clock with
 * the same vi.useFakeTimers()/vi.setSystemTime() idiom
 * app/lib/admin/session-revisions.server.test.ts already uses elsewhere.
 * 12:05:00 sits 5 minutes clear of the boundary on either side (:00 before,
 * :10 after) — dead center of the window.
 */
const PINNED_INSTANT = new Date("2026-08-12T12:05:00.000Z");

describe("the task-upload path is rate limited", () => {
  // Scoped to only the two cases that flood to `limit` requests — the rest of
  // this describe block makes at most 3 requests, nowhere near enough to reach
  // a window boundary's consequences, so they are left on the real clock.
  describe("flood to the cap (wall-clock pinned so the window can't roll mid-test)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(PINNED_INSTANT);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("must fire: a flood through /portal/tasks/:taskId hits the cap", async () => {
      const { limit } = RATE_LIMIT_POLICIES.apiUpload;
      const person = fixture.speakerIds[0];

      const codes: number[] = [];
      for (let attempt = 0; attempt < limit; attempt += 1) {
        codes.push((await uploadToTask(person, TASK_OF(0))).status);
      }
      /*
       * This is the state #85 left behind, and it is why the storage quota is not
       * a substitute for a limiter. The per-owner file-count quota stops the
       * WRITER after ten files, but the other twenty requests were still
       * accepted, still had their bodies buffered, and left no row behind to
       * count them. `limit` attempts, ten objects, ten rows, no 429 anywhere.
       */
      const objectsAtCap = bucket.objects.size;
      const rowsAtCap = uploadRowCount();
      expect(codes).toEqual(Array(limit).fill(200));
      expect(objectsAtCap).toBeLessThan(limit);
      expect(rowsAtCap).toBe(objectsAtCap);

      // Red on the unfixed tree: attempt 31 and 32 were 200s like all the rest.
      expect((await uploadToTask(person, TASK_OF(0))).status).toBe(429);
      expect((await uploadToTask(person, TASK_OF(0))).status).toBe(429);

      const rows = buckets();
      expect(rows).toHaveLength(1);
      expect(rows[0].scope).toBe("upload");
      expect(rows[0].window_count).toBe(limit);
      // The writer really did stop — the refused attempts wrote nothing at all.
      expect(bucket.objects.size).toBe(objectsAtCap);
      expect(uploadRowCount()).toBe(rowsAtCap);
    });

    it("must NOT fire: a different speaker still has a full allowance", async () => {
      // The control. A limiter keyed on something request-global rather than on
      // the caller would pass the test above and let one speaker lock everybody
      // else out of their own tasks.
      const { limit } = RATE_LIMIT_POLICIES.apiUpload;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        await uploadToTask(fixture.speakerIds[0], TASK_OF(0));
      }
      expect((await uploadToTask(fixture.speakerIds[0], TASK_OF(0))).status).toBe(429);

      expect((await uploadToTask(fixture.speakerIds[1], TASK_OF(1))).status).toBe(200);
      const rows = buckets();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.window_count)).toEqual([limit, 1]);
    });
  });

  it("shares ONE bucket with /api/upload rather than granting a second allowance", async () => {
    /*
     * The whole point of the constant `"upload"` scope. The scope is part of
     * the `(scope, identifier_hash, window_start)` primary key AND is HMAC'd
     * into the digest, so a route-specific scope string would be a whole fresh
     * budget — the same multiplier #85 removed for `?event=`, wearing a
     * different hat. Two doors, one cap.
     */
    const person = fixture.speakerIds[0];
    expect((await uploadToTask(person, TASK_OF(0))).status).toBe(200);

    const apiBody = new FormData();
    apiBody.set("file", new File(["bytes"], "note.txt", { type: "text/plain" }));
    apiBody.set("ownerType", "person");
    apiBody.set("ownerId", person);
    const signed = await signedInGet("https://x.test/api/upload", person);
    const apiResponse = (await apiUploadAction({
      request: new Request(signed.url, {
        method: "POST",
        headers: { cookie: signed.headers.get("cookie") as string },
        body: apiBody,
      }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(apiResponse.status).toBe(200);

    const rows = buckets();
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("upload");
    expect(rows[0].window_count).toBe(2);
  });

  it("must still fire: /api/upload alone is unchanged", async () => {
    // api.upload keeps its own budget shape — one person, one bucket, counted
    // per request. This is the assertion that a shared scope did not quietly
    // re-key or double-charge the endpoint #85 already fixed.
    const person = fixture.speakerIds[1];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = new FormData();
      body.set("file", new File(["bytes"], "note.txt", { type: "text/plain" }));
      body.set("ownerType", "person");
      body.set("ownerId", person);
      const signed = await signedInGet("https://x.test/api/upload", person);
      const response = (await apiUploadAction({
        request: new Request(signed.url, {
          method: "POST",
          headers: { cookie: signed.headers.get("cookie") as string },
          body,
        }),
        params: {},
        context: {},
      } as never)) as Response;
      expect(response.status).toBe(200);
    }

    const rows = buckets();
    expect(rows).toHaveLength(1);
    expect(rows[0].window_count).toBe(3);
  });

  it("still completes a legitimate task upload", async () => {
    // Must-still-fire for the feature itself: the limiter must not have broken
    // the flow it guards.
    expect((await uploadToTask(fixture.speakerIds[0], TASK_OF(0))).status).toBe(200);

    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, TASK_OF(0)) });
    expect(row?.status).toBe("complete");
    expect((row?.response as Record<string, unknown>)?.slides).toEqual(expect.any(String));
    expect(bucket.objects.size).toBe(1);
  });
});
