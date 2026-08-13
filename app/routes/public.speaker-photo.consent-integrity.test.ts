/**
 * The two consent-laundering paths onto the ANONYMOUS photo route, re-proven
 * closed against a real database and a real R2.
 *
 * Both are the same class of bug: a `people.photo_publishable` flag that was
 * granted for one specific uploaded file ends up governing a DIFFERENT file, so
 * `/e/:slug/speaker-photo/...` serves bytes nobody agreed to publish. The unit
 * gate in `public.speaker-photo.test.ts` proves the JOIN is correct; this file
 * proves the two write paths that move a `headshot_key` keep the flag honest.
 *
 *   BLOCKER 1 — the CRM merge (`admin.contacts`). Before the fix, a survivor
 *   with `publishable=true` and no photo of its own adopted the duplicate's
 *   `headshot_key` while keeping its own standing `true`: the duplicate's
 *   unconsented photo then served 200 on the survivor's URL. The must-fire is a
 *   404 after the merge; the control is the SAME merge with the duplicate
 *   consenting, which serves 200 — proving the 404 is the duplicate's flag
 *   travelling with its key, not a broken fixture.
 *
 *   BLOCKER 2 — delete then re-add. A speaker's upload consents (flag true);
 *   deleting the photo must lower the flag with the key, so a later admin
 *   replace re-adds a photo that does NOT serve until consent is recorded again.
 *
 * fetchPhoto asserts THROUGH `withSecurityHeaders`, exactly as
 * `public.speaker-photo.test.ts` does and for the same reason: the worker
 * overwrites headers, so the raw loader response is an intermediate value.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, uploads } from "~/db/schema";
import { withSecurityHeaders } from "~/lib/security-headers";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2, type TestR2 } from "~/test/r2";
import {
  EVENT_ID,
  EVENT_SLUG,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { action as contactsAction } from "./admin.contacts";
import { loader as photoLoader } from "./public.speaker-photo";
import { deletePersonUpload, storeUpload } from "~/lib/portal/uploads.server";

/** Recognisable bytes, so "served the right object" is a value assertion. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
/** A full PNG signature, so `storeUpload`'s sniffer accepts the re-add. */
const PNG_FILE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

let ctx: TestDbContext;
let r2: TestR2;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  r2 = createTestR2();
  r2.install();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** Insert a headshot row + object for a person and point them at it. */
async function giveHeadshot(
  personId: string,
  options: { publishable: boolean },
): Promise<{ uploadId: string; key: string }> {
  const uploadId = crypto.randomUUID();
  const key = `${EVENT_ID}/person/${personId}/headshot/${uploadId}-avatar.png`;
  r2.put(key, PNG_BYTES, "image/png");
  await ctx.db.insert(uploads).values({
    id: uploadId,
    eventId: EVENT_ID,
    ownerType: "person",
    ownerId: personId,
    purpose: "headshot",
    key,
    filename: "avatar.png",
    contentType: "image/png",
    sizeBytes: PNG_BYTES.byteLength,
    uploadedById: personId,
  });
  await ctx.db
    .update(people)
    .set({ headshotKey: key, photoPublishable: options.publishable })
    .where(eq(people.id, personId));
  return { uploadId, key };
}

async function fetchPhoto(personId: string, version: string): Promise<Response> {
  const url = `https://x.test/e/${EVENT_SLUG}/speaker-photo/${personId}/${version}`;
  const raw = await (async () => {
    try {
      return (await photoLoader({
        request: new Request(url),
        params: { slug: EVENT_SLUG, personId, version },
        context: {},
      } as unknown as Parameters<typeof photoLoader>[0])) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  })();
  return withSecurityHeaders(raw, url);
}

async function merge(primaryId: string, duplicateId: string) {
  return contactsAction({
    request: await signedInPost("https://x.test/admin/contacts", fixture.adminId, {
      intent: "merge",
      primaryId,
      duplicateId,
    }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof contactsAction>[0]);
}

const flagOf = async (personId: string) =>
  (await ctx.db.query.people.findFirst({ where: eq(people.id, personId) }))?.photoPublishable ??
  false;
const keyOf = async (personId: string) =>
  (await ctx.db.query.people.findFirst({ where: eq(people.id, personId) }))?.headshotKey ?? null;

/**
 * The survivor is a REAL public speaker of the event (published session), so it
 * clears the DECISIONS #58 predicate and the only thing between the request and
 * the bytes is the consent flag. It stands `publishable=true` with NO photo of
 * its own; the duplicate brings the photo.
 */
async function seedMergeAttack(dupPublishable: boolean) {
  const primary = fixture.speakerIds[0];
  const duplicateId = crypto.randomUUID();
  await ctx.db.insert(people).values({
    id: duplicateId,
    email: `dup-${duplicateId}@example.com`,
    fullName: "Duplicate Person",
  });
  const photo = await giveHeadshot(duplicateId, { publishable: dupPublishable });
  await ctx.db
    .update(people)
    .set({ photoPublishable: true, headshotKey: null })
    .where(eq(people.id, primary));
  return { primary, duplicateId, ...photo };
}

describe("BLOCKER 1 — the merge cannot launder a headshot onto standing consent", () => {
  it("MUST FIRE: the duplicate's UNCONSENTED photo 404s after the merge", async () => {
    const { primary, duplicateId, uploadId, key } = await seedMergeAttack(false);

    // Before the merge the survivor points at nothing, so the URL already 404s.
    expect((await fetchPhoto(primary, uploadId)).status).toBe(404);

    expect(await merge(primary, duplicateId)).toMatchObject({ ok: true });

    // The survivor adopted the duplicate's KEY — and the flag came WITH it, so
    // the survivor now reads the duplicate's `false`, not its own standing true.
    expect(await keyOf(primary)).toBe(key);
    expect(await flagOf(primary)).toBe(false);

    const response = await fetchPhoto(primary, uploadId);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.");
    // The bytes are never handed out.
    expect(r2.has(key)).toBe(true); // the object exists…
  });

  it("CONTROL: the SAME merge with a CONSENTED duplicate serves 200 — the flag is what talks", async () => {
    const { primary, duplicateId, uploadId, key } = await seedMergeAttack(true);
    // The survivor's own standing flag is true in BOTH tests; only the duplicate's
    // flag differs. A 200 here with a 404 above proves the served result is
    // governed by the duplicate's consent that travelled with its key.
    expect(await merge(primary, duplicateId)).toMatchObject({ ok: true });

    expect(await keyOf(primary)).toBe(key);
    expect(await flagOf(primary)).toBe(true);

    const response = await fetchPhoto(primary, uploadId);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("MUST NOT FIRE: a survivor that keeps its OWN photo keeps its OWN flag, and the loser's key never installs", async () => {
    const primary = fixture.speakerIds[0];
    const own = await giveHeadshot(primary, { publishable: true });
    const duplicateId = crypto.randomUUID();
    await ctx.db.insert(people).values({
      id: duplicateId,
      email: `dup2-${duplicateId}@example.com`,
      fullName: "Duplicate Two",
    });
    const loser = await giveHeadshot(duplicateId, { publishable: false });

    expect(await merge(primary, duplicateId)).toMatchObject({ ok: true });

    // Survivor kept its own key/flag; the loser's key was not adopted.
    expect(await keyOf(primary)).toBe(own.key);
    expect(await flagOf(primary)).toBe(true);
    expect((await fetchPhoto(primary, own.uploadId)).status).toBe(200);
    expect((await fetchPhoto(primary, loser.uploadId)).status).toBe(404);
  });
});

describe("BLOCKER 2 — a deleted photo's consent does not survive a re-add", () => {
  it("MUST NOT FIRE: after delete + re-add, the new photo does not serve without fresh consent", async () => {
    const speaker = fixture.speakerIds[0];

    // 1. The speaker's own upload is the consent event: photo present, flag true.
    const first = await storeUpload({
      file: new File([PNG_FILE_BYTES], "face.png", { type: "image/png" }),
      eventId: EVENT_ID,
      ownerType: "person",
      ownerId: speaker,
      purpose: "headshot",
      uploadedById: speaker,
    });
    expect(first.ok).toBe(true);
    await ctx.db
      .update(people)
      .set({ photoPublishable: true })
      .where(eq(people.id, speaker));
    const firstId = first.ok ? first.upload.id : "";
    expect((await fetchPhoto(speaker, firstId)).status).toBe(200);

    // 2. The speaker deletes the headshot. The consented artifact is gone, so the
    //    flag falls with the key — otherwise it would pre-arm the next photo.
    expect(await deletePersonUpload(speaker, firstId)).toBe(true);
    expect(await keyOf(speaker)).toBeNull();
    expect(await flagOf(speaker)).toBe(false);

    // 3. An admin re-adds a photo (the replace action never touches the flag).
    const second = await storeUpload({
      file: new File([PNG_FILE_BYTES], "new-face.png", { type: "image/png" }),
      eventId: EVENT_ID,
      ownerType: "person",
      ownerId: speaker,
      purpose: "headshot",
      uploadedById: fixture.adminId,
    });
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.upload.id : "";

    // The re-added photo is present and correctly addressed — and it 404s,
    // because nobody has consented to THIS photo.
    expect(await keyOf(speaker)).not.toBeNull();
    expect(await flagOf(speaker)).toBe(false);
    expect((await fetchPhoto(speaker, secondId)).status).toBe(404);

    // COMPLEMENT: a fresh consent act on the SAME url serves it, proving the 404
    // was the missing consent and not a broken fixture.
    await ctx.db
      .update(people)
      .set({ photoPublishable: true })
      .where(eq(people.id, speaker));
    expect((await fetchPhoto(speaker, secondId)).status).toBe(200);
  });
});
