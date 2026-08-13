/**
 * The consent gate on `/e/:slug/speaker-photo/:personId/:version`.
 *
 * This is the file that has to be right. Everything else in the photo lane is
 * presentation: if this route serves a headshot for somebody who did not agree
 * to it, no amount of correct rendering elsewhere matters.
 *
 * Every refusal below is checked with a REAL, CORRECT upload id and a REAL,
 * CORRECT person — the URL an attacker would have if they had once seen the
 * page, or if they had watched somebody's photo get published and then
 * unpublished. A 404 that only ever fires for a made-up id proves nothing.
 *
 * Red-mutation proof for the central case: delete
 * `eq(people.photoPublishable, true)` from `publishableHeadshotJoin()` in
 * `public-speakers.server.ts` and rerun. "an unpublishable person's own upload
 * id" must go green→red. It does; the complement test below (`flipping the flag
 * back on serves the SAME url`) is what proves the 404 was the flag talking and
 * not a broken fixture.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, uploads } from "~/db/schema";
import { withSecurityHeaders } from "~/lib/security-headers";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2, type TestR2 } from "~/test/r2";
import {
  EVENT_ID,
  EVENT_SLUG,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { loader } from "./public.speaker-photo";

let ctx: TestDbContext;
let r2: TestR2;
let fixture: DemoFixture;

/** Recognisable bytes, so "served the right object" is a value assertion. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);

beforeEach(async () => {
  ctx = installTestDb();
  r2 = createTestR2();
  r2.install();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function giveHeadshot(
  personId: string,
  options: { publishable: boolean; contentType?: string } = { publishable: true },
): Promise<{ uploadId: string; key: string }> {
  const uploadId = crypto.randomUUID();
  const contentType = options.contentType ?? "image/png";
  const key = `${EVENT_ID}/person/${personId}/headshot/${uploadId}-avatar.png`;

  r2.put(key, PNG_BYTES, contentType);
  await ctx.db.insert(uploads).values({
    id: uploadId,
    eventId: EVENT_ID,
    ownerType: "person",
    ownerId: personId,
    purpose: "headshot",
    key,
    filename: "avatar.png",
    contentType,
    sizeBytes: PNG_BYTES.byteLength,
    uploadedById: personId,
  });
  await ctx.db
    .update(people)
    .set({ headshotKey: key, photoPublishable: options.publishable })
    .where(eq(people.id, personId));

  return { uploadId, key };
}

/**
 * The loader's response AS THE WORKER SHIPS IT.
 *
 * `workers/app.ts` pipes every response through `withSecurityHeaders`, which
 * OVERWRITES `content-security-policy` unconditionally. A test that asserted
 * the raw loader response would have been measuring an intermediate value: an
 * earlier cut of this route set its own `default-src 'none'; sandbox`, that
 * assertion passed, and a live `curl` showed the site-wide policy on the wire.
 * Asserting through the middleware is the only way this file can be evidence
 * about what a visitor receives.
 */
async function fetchPhoto(personId: string, version: string): Promise<Response> {
  const url = `https://x.test/e/${EVENT_SLUG}/speaker-photo/${personId}/${version}`;
  const raw = await (async () => {
    try {
      return (await loader({
        request: new Request(url),
        params: { slug: EVENT_SLUG, personId, version },
        context: {},
      } as unknown as Parameters<typeof loader>[0])) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  })();
  return withSecurityHeaders(raw, url);
}

describe("MUST FIRE — a consented photo is served", () => {
  it("streams the object with an image content type and an immutable, content-addressed cache", async () => {
    const { uploadId } = await giveHeadshot(fixture.speakerIds[0]);

    const response = await fetchPhoto(fixture.speakerIds[0], uploadId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    // The site-wide policy, because that is what actually ships. See the
    // comment on `fetchPhoto`.
    expect(response.headers.get("content-security-policy")).toBe(
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    // The BYTES, not merely a 200: a route that streamed the wrong object would
    // pass every header assertion above.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });
});

describe("MUST NOT FIRE — the gate", () => {
  it("404s an unpublishable person addressed by their OWN real upload id", async () => {
    const { uploadId } = await giveHeadshot(fixture.speakerIds[0], { publishable: false });

    const response = await fetchPhoto(fixture.speakerIds[0], uploadId);

    expect(response.status).toBe(404);
    // The refusal must not describe itself. "no consent" and "no such person"
    // answering differently would turn this endpoint into a directory.
    expect(await response.text()).toBe("Not found.");
  });

  it("COMPLEMENT: flipping the flag back on serves the SAME url", async () => {
    const { uploadId } = await giveHeadshot(fixture.speakerIds[0], { publishable: false });
    expect((await fetchPhoto(fixture.speakerIds[0], uploadId)).status).toBe(404);

    await ctx.db
      .update(people)
      .set({ photoPublishable: true })
      .where(eq(people.id, fixture.speakerIds[0]));

    expect((await fetchPhoto(fixture.speakerIds[0], uploadId)).status).toBe(200);
  });

  it("404s a stale version — another person's real upload id on a consented person", async () => {
    await giveHeadshot(fixture.speakerIds[0], { publishable: true });
    const other = await giveHeadshot(fixture.speakerIds[1], { publishable: true });

    const response = await fetchPhoto(fixture.speakerIds[0], other.uploadId);

    expect(response.status).toBe(404);
  });

  it("404s a consented photo whose owner is not a public speaker of this event", async () => {
    // speakerIds[2] has abstracts but no PUBLISHED session, so they never
    // qualify under the DECISIONS #58 predicate no matter what they consented to.
    const { uploadId } = await giveHeadshot(fixture.speakerIds[2], { publishable: true });

    const response = await fetchPhoto(fixture.speakerIds[2], uploadId);

    expect(response.status).toBe(404);
  });

  it("404s a consented, correctly addressed object stored as a non-image type", async () => {
    const { uploadId } = await giveHeadshot(fixture.speakerIds[0], {
      publishable: true,
      contentType: "text/html",
    });

    const response = await fetchPhoto(fixture.speakerIds[0], uploadId);

    // Every database condition passes here. The refusal comes from the
    // allowlist in `publicImageResponse`, which is the only thing standing
    // between an anonymous same-origin URL and stored HTML.
    expect(response.status).toBe(404);
  });

  it("404s when the row exists but the object does not", async () => {
    const { uploadId, key } = await giveHeadshot(fixture.speakerIds[0]);
    expect(r2.has(key)).toBe(true);
    // A bucket/database divergence, exercised rather than assumed impossible.
    const { deleteObject } = await import("~/lib/r2.server");
    await deleteObject(key);
    expect(r2.has(key)).toBe(false);

    const response = await fetchPhoto(fixture.speakerIds[0], uploadId);

    expect(response.status).toBe(404);
  });

  it("404s on an unknown event slug", async () => {
    const { uploadId } = await giveHeadshot(fixture.speakerIds[0]);

    const response = (await (async () => {
      try {
        return (await loader({
          request: new Request("https://x.test/e/nope/speaker-photo/x/y"),
          params: { slug: "nope", personId: fixture.speakerIds[0], version: uploadId },
          context: {},
        } as unknown as Parameters<typeof loader>[0])) as Response;
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
    })()) as Response;

    expect(response.status).toBe(404);
  });
});
