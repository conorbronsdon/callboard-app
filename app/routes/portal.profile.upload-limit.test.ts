/**
 * `/portal/profile` is the THIRD door into `storeUpload`.
 *
 * #85 capped `/api/upload`. #90 capped `/portal/tasks/:taskId` and its comment
 * said that covered "both doors". A full enumeration of `storeUpload` callers
 * finds four, and this one — headshot and slide uploads on the speaker's own
 * profile — had no limiter at all. Rejected uploads leave no `uploads` row, so
 * the per-owner storage quota does not cap the attempts either: the identical
 * argument that made the original finding.
 *
 * Every case asserts against the STORED bucket rows as well as the response, so
 * a limiter wired to the wrong scope, or to a per-request identifier, fails
 * here rather than looking green because a 429 arrived from somewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_POLICIES } from "~/lib/rate-limit.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { env } from "~/test/workers-env";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action } from "./portal.profile";
import { action as apiUploadAction } from "./api.upload";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

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

/**
 * A real PNG magic number. `storeUpload` sniffs the leading bytes, so a
 * headshot fixture of plain text is rejected before the limiter question is
 * even asked — and a flood test whose uploads never succeed would pass on the
 * unfixed tree for the wrong reason.
 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

let ctx: TestDbContext;
let fixture: DemoFixture;
let bucket: ReturnType<typeof createTestBucket>;

beforeEach(async () => {
  ctx = installTestDb();
  bucket = createTestBucket();
  env.FILES = bucket.binding;
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** One profile upload. `intent` picks the headshot or the document form. */
async function uploadToProfile(
  personId: string,
  intent: "headshot" | "document" = "document",
): Promise<{ status: number; body: unknown }> {
  const body = new FormData();
  body.set("intent", intent);
  body.set(
    "file",
    intent === "headshot"
      ? new File([PNG_BYTES], "face.png", { type: "image/png" })
      : new File(["slide bytes"], "deck.txt", { type: "text/plain" }),
  );

  const signed = await signedInGet("https://x.test/portal/profile", personId);
  const request = new Request(signed.url, {
    method: "POST",
    headers: { cookie: signed.headers.get("cookie") as string },
    body,
  });

  try {
    return { status: 200, body: await action(args(request)) };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, body: null };
    throw thrown;
  }
}

/** A non-upload intent on the same route, to prove the charge is per request. */
async function saveDetails(personId: string): Promise<number> {
  const body = new FormData();
  body.set("intent", "details");
  body.set("fullName", "Sam Speaker");
  const signed = await signedInGet("https://x.test/portal/profile", personId);
  try {
    await action(
      args(
        new Request(signed.url, {
          method: "POST",
          headers: { cookie: signed.headers.get("cookie") as string },
          body,
        }),
      ),
    );
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

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

describe("the profile-upload path is rate limited", () => {
  // Scoped to only the two cases that flood to `limit` requests — the rest of
  // this describe block makes at most 2 requests, nowhere near enough to reach
  // a window boundary's consequences, so they are left on the real clock.
  describe("flood to the cap (wall-clock pinned so the window can't roll mid-test)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(PINNED_INSTANT);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("must fire: a flood through /portal/profile hits the cap", async () => {
      const { limit } = RATE_LIMIT_POLICIES.apiUpload;
      const person = fixture.speakerIds[0];

      const codes: number[] = [];
      for (let attempt = 0; attempt < limit; attempt += 1) {
        codes.push((await uploadToProfile(person)).status);
      }
      /*
       * The state this route was left in. The per-owner file-count quota stops
       * the WRITER, but the remaining requests were still accepted, still had
       * their bodies buffered, and left no row behind to count them.
       */
      const objectsAtCap = bucket.objects.size;
      const rowsAtCap = uploadRowCount();
      expect(codes).toEqual(Array(limit).fill(200));
      expect(objectsAtCap).toBeLessThan(limit);
      expect(rowsAtCap).toBe(objectsAtCap);

      // Red on the unfixed tree: attempts 31 and 32 were 200s like all the rest.
      expect((await uploadToProfile(person)).status).toBe(429);
      expect((await uploadToProfile(person, "headshot")).status).toBe(429);

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
      // the caller would pass the test above and lock everybody else out of
      // their own profile.
      const { limit } = RATE_LIMIT_POLICIES.apiUpload;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        await uploadToProfile(fixture.speakerIds[0]);
      }
      expect((await uploadToProfile(fixture.speakerIds[0])).status).toBe(429);

      expect((await uploadToProfile(fixture.speakerIds[1])).status).toBe(200);
      const rows = buckets();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.window_count)).toEqual([limit, 1]);
    });
  });

  it("shares ONE bucket with /api/upload rather than granting a third allowance", async () => {
    // The whole point of the constant `"upload"` scope: scope is part of the
    // `(scope, identifier_hash, window_start)` primary key AND is HMAC'd into
    // the digest, so a route-specific string would be a whole fresh budget.
    const person = fixture.speakerIds[0];
    expect((await uploadToProfile(person)).status).toBe(200);

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

  it("charges every intent, because the limiter runs before the body is read", async () => {
    // Documents the deliberate strictness rather than leaving it to the
    // comment: a "save my bio" click is charged too, since whether a file is
    // attached is not knowable until the body this call exists to skip.
    expect(await saveDetails(fixture.speakerIds[0])).toBe(200);
    expect(buckets()).toEqual([{ scope: "upload", window_count: 1 }]);
  });

  it("still completes a legitimate headshot and document upload", async () => {
    // Must-still-fire for the feature itself: the limiter must not have broken
    // the flow it guards.
    const person = fixture.speakerIds[0];
    expect(await uploadToProfile(person, "headshot")).toMatchObject({
      status: 200,
      body: { ok: "Headshot updated.", intent: "headshot" },
    });
    expect(await uploadToProfile(person, "document")).toMatchObject({
      status: 200,
      body: { ok: "Uploaded deck.txt.", intent: "document" },
    });
    expect(bucket.objects.size).toBe(2);
    expect(uploadRowCount()).toBe(2);
  });
});
