/**
 * SPK-08 (organizer half) and CNT-10 (photo half) on `/admin/speakers/:id`.
 *
 * Two capabilities and one restraint:
 *   · the organizer SEES the headshot on file — the SPK-08 gap, where the page
 *     had no avatar and the loader did not even select the column;
 *   · the organizer REPLACES it — the CNT-10 gap, previously reachable only by
 *     impersonating the speaker and using their own profile form;
 *   · replacing it does NOT publish it. Consent is the speaker's to give
 *     (DECISIONS #66); the toggle beside it is where an organizer records
 *     permission obtained out of band, as a separate, deliberate act.
 *
 * The admin preview reads the AUTH-GATED `/portal/headshot/:personId`, not the
 * public route, so an organizer can look at a photo in order to decide whether
 * to publish it. Asserting that specific href is the point — swapping it for
 * the public URL would make the preview go blank for exactly the speakers the
 * decision is about.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, uploads } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2, type TestR2 } from "~/test/r2";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { SpeakerView, action, loader, speakerLoaderPayload } from "./admin.speaker";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

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

const load = async (id: string) =>
  speakerLoaderPayload(
    await loader({
      request: await signedInGet(`https://x.test/admin/speakers/${id}`, fixture.adminId),
      params: { id },
      context: {},
    } as unknown as Parameters<typeof loader>[0]),
  );

async function post(id: string, fields: Record<string, string>) {
  return action({
    request: await signedInPost(`https://x.test/admin/speakers/${id}`, fixture.adminId, fields),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof action>[0]);
}

async function uploadAs(id: string, personId: string) {
  const body = new FormData();
  body.set("intent", "replace-headshot");
  body.set("file", new File([PNG_BYTES], "new-face.png", { type: "image/png" }));
  const signed = await signedInGet(`https://x.test/admin/speakers/${id}`, personId);
  return action({
    request: new Request(signed.url, {
      method: "POST",
      headers: { cookie: signed.headers.get("cookie") as string },
      body,
    }),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof action>[0]);
}

const flag = async (personId: string) =>
  (await ctx.db.query.people.findFirst({ where: eq(people.id, personId) }))?.photoPublishable ??
  false;

const markup = async (id: string) =>
  renderToStaticMarkup(<SpeakerView {...(await load(id))} />);

describe("MUST FIRE — the organizer sees the headshot", () => {
  it("renders the auth-gated preview and the file metadata once one exists", async () => {
    const speaker = fixture.speakerIds[0];
    expect(await markup(speaker)).toContain('data-testid="speaker-headshot-empty"');

    await uploadAs(speaker, fixture.adminId);
    const data = await load(speaker);

    expect(data.headshot).toMatchObject({ filename: "new-face.png" });
    const html = await markup(speaker);
    expect(html).toContain(`/portal/headshot/${speaker}`);
    expect(html).toContain("new-face.png");
    expect(html).not.toContain("speaker-headshot-empty");
    // The public URL must NOT be what the admin preview points at.
    expect(html).not.toContain("/speaker-photo/");
  });

  it("names the current photo through people.headshot_key, not the newest row", async () => {
    const speaker = fixture.speakerIds[0];
    await uploadAs(speaker, fixture.adminId);
    const current = await ctx.db.query.people.findFirst({ where: eq(people.id, speaker) });

    const rows = await ctx.db.select().from(uploads).where(eq(uploads.ownerId, speaker));
    // `storeUpload` deletes the superseded object and row, so "current" and
    // "newest" agree here; the loader joins on the key so they cannot diverge.
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(current?.headshotKey);
    expect((await load(speaker)).headshot?.uploadId).toBe(rows[0].id);
  });
});

/**
 * Conor's live-demo report reproduced on the ADMIN record too: an organizer
 * replacing a headshot from `/admin/speakers/:id` hits the same
 * `/portal/headshot/:personId` preview `portal.profile.tsx` does, with the
 * same defect — the URL names the PERSON, never WHICH photo, so it is
 * byte-identical before and after a replace and a browser that already
 * painted the old preview never refetches. `admin.speaker.headshot-refresh.
 * test.tsx` does not exist as a separate file on purpose: this one already
 * owns every fixture and helper this needs.
 */
describe("MUST FIRE — replacing a headshot changes the preview URL", () => {
  it("the admin preview's src differs before and after a replace", async () => {
    const speaker = fixture.speakerIds[0];

    await uploadAs(speaker, fixture.adminId);
    const firstSrc = /src="(\/portal\/headshot\/[^"]*)"/.exec(await markup(speaker))?.[1];
    expect(firstSrc).toBeDefined();

    await uploadAs(speaker, fixture.adminId);
    const secondSrc = /src="(\/portal\/headshot\/[^"]*)"/.exec(await markup(speaker))?.[1];
    expect(secondSrc).toBeDefined();

    // The bug: the unfixed markup renders `/portal/headshot/${speaker}` both
    // times with nothing to tell the two photos apart.
    expect(secondSrc).not.toBe(firstSrc);
    expect(secondSrc).toContain(`/portal/headshot/${speaker}`);
  });
});

describe("MUST FIRE — the organizer publishes and unpublishes", () => {
  it("flips photo_publishable in both directions and says which state it is in", async () => {
    const speaker = fixture.speakerIds[0];
    await uploadAs(speaker, fixture.adminId);
    expect(await flag(speaker)).toBe(false);

    await expect(
      post(speaker, { intent: "set-photo-publishable", value: "1" }),
    ).resolves.toMatchObject({ ok: true });
    expect(await flag(speaker)).toBe(true);
    expect(await markup(speaker)).toContain("Shown on the public speaker pages.");

    // The complement. A toggle tested in one direction is a toggle nobody has
    // tested — un-publishing is the half that matters for a withdrawal.
    await expect(
      post(speaker, { intent: "set-photo-publishable", value: "0" }),
    ).resolves.toMatchObject({ ok: true });
    expect(await flag(speaker)).toBe(false);
    expect(await markup(speaker)).toContain("Private — not shown on any public page.");
  });

  it("refuses a person who is not on this event's roster", async () => {
    // Membership is re-checked on the write, not merely used to render the page.
    await expect(
      post("00000000-0000-4000-8000-000000000999", {
        intent: "set-photo-publishable",
        value: "1",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("MUST NOT FIRE — an organizer's upload is not the speaker's consent", () => {
  it("leaves photo_publishable false when the organizer uploads a new headshot", async () => {
    const speaker = fixture.speakerIds[0];

    await expect(uploadAs(speaker, fixture.adminId)).resolves.toMatchObject({
      ok: true,
      notice: "Headshot replaced.",
    });

    expect(await flag(speaker)).toBe(false);
  });

  it("PRESERVES an existing consent when the organizer replaces the photo", async () => {
    // The other direction of the same rule, and the one a naive "organizer
    // uploads never publish" implementation gets wrong: a speaker who agreed to
    // be shown must not silently vanish from the gallery because an organizer
    // fixed their crop.
    const speaker = fixture.speakerIds[0];
    // A headshot has to exist before it can be published — see the guard test
    // below. Upload it (organizer uploads never consent), then record consent.
    await uploadAs(speaker, fixture.adminId);
    await post(speaker, { intent: "set-photo-publishable", value: "1" });
    expect(await flag(speaker)).toBe(true);

    await uploadAs(speaker, fixture.adminId);

    expect(await flag(speaker)).toBe(true);
  });

  it("does not touch any other speaker's flag", async () => {
    await uploadAs(fixture.speakerIds[0], fixture.adminId);
    await post(fixture.speakerIds[0], { intent: "set-photo-publishable", value: "1" });
    expect(await flag(fixture.speakerIds[0])).toBe(true);
    expect(await flag(fixture.speakerIds[1])).toBe(false);
    expect(await flag(fixture.speakerIds[2])).toBe(false);
  });
});

describe("MUST NOT FIRE — consent cannot be pre-armed on a record with no photo", () => {
  it("refuses to publish, and hides the toggle, when there is no headshot", async () => {
    const speaker = fixture.speakerIds[0];
    // No headshot uploaded: the flag has nothing to attach to. A standing true
    // here would pre-arm the NEXT upload to go public with no fresh consent —
    // the same laundering the merge and delete paths close.
    expect((await load(speaker)).headshot).toBeNull();
    expect(await markup(speaker)).not.toContain('data-testid="speaker-photo-toggle"');

    await expect(
      post(speaker, { intent: "set-photo-publishable", value: "1" }),
    ).resolves.toMatchObject({ ok: false, error: "Upload a headshot before publishing it." });
    expect(await flag(speaker)).toBe(false);

    // COMPLEMENT: the very same POST succeeds once a headshot exists, proving the
    // refusal is the missing photo talking and not a broken fixture.
    await uploadAs(speaker, fixture.adminId);
    await expect(
      post(speaker, { intent: "set-photo-publishable", value: "1" }),
    ).resolves.toMatchObject({ ok: true });
    expect(await flag(speaker)).toBe(true);
  });
});
