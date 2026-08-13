/**
 * What sets `people.photo_publishable`, and — more importantly — what does not.
 *
 * DECISIONS #66 makes a portal headshot upload the consent event: the notice is
 * on screen beside the control, so uploading with it visible is the permission.
 * That claim is only true while three things hold, and each has a test here:
 *
 *   1. the notice is actually RENDERED (a consent flag set by a form whose
 *      notice has been deleted is worse than no flag),
 *   2. a speaker's own upload raises the flag, and
 *   3. nothing else does — not an organizer uploading through view-as, not a
 *      slides upload on the same form, not the authenticated `/api/upload`
 *      endpoint, which has no notice on it because it has no UI at all.
 *
 * Red-mutation proof: drop `&& !actor.impersonatedBy` from the headshot branch
 * in `portal.profile.tsx` and rerun. "an organizer uploading through view-as"
 * must go green→red. Delete the whole block and cases 2 fails instead — the two
 * directions are separately load-bearing.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2 } from "~/test/r2";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as apiUploadAction } from "./api.upload";
import PortalProfile, {
  PUBLIC_PHOTO_NOTICE,
  action,
  loader,
} from "./portal.profile";
import { action as impersonateAction } from "./portal.impersonate";

/** A real PNG magic number — `storeUpload` sniffs before it stores. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  createTestR2().install();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const publishable = async (personId: string): Promise<boolean> => {
  const row = await ctx.db.query.people.findFirst({ where: eq(people.id, personId) });
  return row?.photoPublishable ?? false;
};

async function uploadHeadshot(
  personId: string,
  options: { intent?: "headshot" | "document"; viewAsCookie?: string } = {},
) {
  const intent = options.intent ?? "headshot";
  const body = new FormData();
  body.set("intent", intent);
  body.set(
    "file",
    intent === "headshot"
      ? new File([PNG_BYTES], "face.png", { type: "image/png" })
      : new File(["slides"], "deck.txt", { type: "text/plain" }),
  );

  const signed = await signedInGet("https://x.test/portal/profile", personId);
  const cookie = signed.headers.get("cookie") as string;
  return action({
    request: new Request(signed.url, {
      method: "POST",
      headers: { cookie: options.viewAsCookie ? `${cookie}; ${options.viewAsCookie}` : cookie },
      body,
    }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof action>[0]);
}

describe("the notice that makes the upload a consent event", () => {
  it("MUST FIRE: the public-use notice renders beside the upload control", async () => {
    const request = await signedInGet(
      "https://x.test/portal/profile",
      fixture.speakerIds[0],
    );
    const data = await loader({
      request,
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);

    // `useNavigation` and `<Form>` both need a router; stub one rather than
    // pulling the notice into a component the real page might stop rendering.
    const Stub = createRoutesStub([
      {
        path: "/portal/profile",
        Component: () =>
          PortalProfile({ loaderData: data } as unknown as Parameters<typeof PortalProfile>[0]),
      },
    ]);
    const html = renderToStaticMarkup(<Stub initialEntries={["/portal/profile"]} />);

    expect(html).toContain('data-testid="headshot-public-notice"');
    // The sentence itself, not merely the container: the words are the consent
    // basis, so a notice quietly reworded into "may be used for the event"
    // must fail here rather than ship.
    expect(html).toContain("publishes it on the public speaker pages");
    // Consent is GLOBAL (`people.photo_publishable`, no event column), so the
    // notice has to say the photo publishes across every event the person
    // speaks at — not "this event's pages", which the cross-event serving in
    // `resolvePublicSpeakerPhotoKey` would make a lie (DECISIONS #66).
    expect(html).toContain("for every event where you speak, not only this one");
    expect(PUBLIC_PHOTO_NOTICE).toContain("public speaker pages");
    // Rendered BEFORE the file input, so it cannot be read after the fact.
    expect(html.indexOf("headshot-public-notice")).toBeLessThan(
      html.indexOf('id="headshot"'),
    );
  });
});

describe("MUST FIRE — the speaker's own upload is consent", () => {
  it("raises photo_publishable on a headshot upload", async () => {
    expect(await publishable(fixture.speakerIds[0])).toBe(false);

    await expect(uploadHeadshot(fixture.speakerIds[0])).resolves.toMatchObject({
      ok: "Headshot updated.",
    });

    expect(await publishable(fixture.speakerIds[0])).toBe(true);
  });

  it("keeps the flag raised when the speaker replaces the photo", async () => {
    await uploadHeadshot(fixture.speakerIds[0]);
    await uploadHeadshot(fixture.speakerIds[0]);
    expect(await publishable(fixture.speakerIds[0])).toBe(true);
  });
});

describe("MUST NOT FIRE — everything that is not the speaker's own act", () => {
  it("does not raise the flag when an organizer uploads through view-as", async () => {
    const target = fixture.speakerIds[0];
    const start = (await impersonateAction({
      request: await signedInPost("https://x.test/portal/impersonate", fixture.adminId, {
        personId: target,
      }),
      params: {},
      context: {},
    } as unknown as Parameters<typeof impersonateAction>[0])) as Response;
    const viewAsCookie = (start.headers.get("set-cookie") as string).split(";")[0];

    // The organizer's session, wearing the speaker's view. The upload itself
    // succeeds — this is a real capability, not a blocked one.
    const result = await uploadHeadshot(fixture.adminId, { viewAsCookie });
    expect(result).toMatchObject({ ok: "Headshot updated." });

    // ...but the photo is the speaker's to publish, and they did not.
    expect(await publishable(target)).toBe(false);
  });

  it("does not raise the flag on a slides upload from the same form", async () => {
    await expect(
      uploadHeadshot(fixture.speakerIds[0], { intent: "document" }),
    ).resolves.toMatchObject({ ok: "Uploaded deck.txt." });
    expect(await publishable(fixture.speakerIds[0])).toBe(false);
  });

  it("does not raise the flag for a headshot posted to /api/upload", async () => {
    // The API door renders no notice because it renders nothing. A speaker
    // scripting against it has not been told anything, so it cannot consent
    // for them.
    const body = new FormData();
    body.set("file", new File([PNG_BYTES], "face.png", { type: "image/png" }));
    body.set("ownerType", "person");
    body.set("ownerId", fixture.speakerIds[0]);
    body.set("purpose", "headshot");

    const signed = await signedInGet("https://x.test/api/upload", fixture.speakerIds[0]);
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
    expect(await publishable(fixture.speakerIds[0])).toBe(false);
  });

  it("does not raise the flag for OTHER speakers", async () => {
    // The control against a write that forgot its `where` clause.
    await uploadHeadshot(fixture.speakerIds[0]);
    expect(await publishable(fixture.speakerIds[0])).toBe(true);
    expect(await publishable(fixture.speakerIds[1])).toBe(false);
    expect(await publishable(fixture.speakerIds[2])).toBe(false);
  });
});
