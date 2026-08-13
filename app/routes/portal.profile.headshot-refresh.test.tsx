/**
 * Conor's live-demo report: "when I upload a headshot it doesn't actually
 * replace the speaker's image." Reproduced on `/portal/profile` — the
 * speaker's OWN view, which DECISIONS #57/#66 says must show a fresh upload
 * immediately (it is auth-gated, not the consent-gated public surface).
 *
 * `people.headshot_key` is repointed correctly on every replace
 * (`storeUpload`, `app/lib/portal/uploads.server.ts`) and `/portal/headshot/
 * :personId` always resolves it fresh server-side — so the BYTES were never
 * stale. The bug is client-side: both avatars on this page render
 * `src="/portal/headshot/${person.id}"`, a string that is byte-IDENTICAL
 * before and after a replace (same person, same route — nothing in the URL
 * names WHICH photo). React's reconciler does not touch a DOM attribute whose
 * value did not change, so a browser that already painted the old headshot
 * never issues a new request for the new one, independent of any
 * Cache-Control header. This file proves that at the string level: two
 * renders of the SAME route, separated by a real replace through the SAME
 * action this page's form posts to, must produce two DIFFERENT `src`
 * strings — that is the whole fix (`portalHeadshotHref`, `~/lib/portal-
 * uploads`), and it is exactly what the current, unfixed markup does not do.
 *
 * `tests/e2e/portal-headshot-refresh.spec.ts` is the browser-level twin: this
 * file proves the URL now changes, that spec proves a real Chromium tab
 * actually refetches and repaints when it does.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { createTestR2 } from "~/test/r2";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import PortalProfile, { action, loader } from "./portal.profile";
import { loader as headshotLoader } from "./portal.headshot";

const pngBytes = (tag: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag]);

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  createTestR2().install();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function uploadHeadshot(personId: string, tag: number, filename: string) {
  const body = new FormData();
  body.set("intent", "headshot");
  body.set("file", new File([pngBytes(tag)], filename, { type: "image/png" }));

  const signed = await signedInGet("https://x.test/portal/profile", personId);
  return action({
    request: new Request(signed.url, {
      method: "POST",
      headers: { cookie: signed.headers.get("cookie") as string },
      body,
    }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof action>[0]);
}

async function renderProfile(personId: string): Promise<string> {
  const data = await loader({
    request: await signedInGet("https://x.test/portal/profile", personId),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]);

  // `useNavigation` and `<Form>` need a router — same stub the sibling
  // consent test uses, for the same reason.
  const Stub = createRoutesStub([
    {
      path: "/portal/profile",
      Component: () =>
        PortalProfile({ loaderData: data } as unknown as Parameters<typeof PortalProfile>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/portal/profile"]} />);
}

/** Both avatars on the page point at the same route; pull every `src` it renders. */
function headshotSrcs(html: string): string[] {
  return [...html.matchAll(/src="(\/portal\/headshot\/[^"]*)"/g)].map((match) => match[1]);
}

describe("MUST FIRE — replacing a headshot changes the URL the page renders", () => {
  it("the profile avatar's src differs before and after a replace", async () => {
    const speaker = fixture.speakerIds[0];

    await expect(uploadHeadshot(speaker, 1, "face-a.png")).resolves.toMatchObject({
      ok: "Headshot updated.",
    });
    const afterFirst = headshotSrcs(await renderProfile(speaker));
    expect(afterFirst.length).toBeGreaterThan(0);
    // Both avatars on the page agree with each other.
    expect(new Set(afterFirst).size).toBe(1);

    await expect(uploadHeadshot(speaker, 2, "face-b.png")).resolves.toMatchObject({
      ok: "Headshot updated.",
    });
    const afterSecond = headshotSrcs(await renderProfile(speaker));
    expect(afterSecond.length).toBeGreaterThan(0);
    expect(new Set(afterSecond).size).toBe(1);

    // The bug: on the unfixed route both renders say
    // `/portal/headshot/${speaker}` with nothing else, so this is the same
    // string twice. A browser that already painted face-a never refetches
    // for face-b because the <img src> it is diffing against never changes.
    expect(afterSecond[0]).not.toBe(afterFirst[0]);
    // Sanity: still the same route, same person — just versioned now.
    expect(afterSecond[0]).toContain(`/portal/headshot/${speaker}`);
  });
});

describe("MUST NOT FIRE — the new ?v= query never widens who can read the file", () => {
  it("a stranger's cookie still 404s on the exact URL the owner's page now renders", async () => {
    const owner = fixture.speakerIds[0];
    const stranger = fixture.speakerIds[1];
    await uploadHeadshot(owner, 3, "face-c.png");

    const [src] = headshotSrcs(await renderProfile(owner));
    expect(src).toContain("?v="); // guards against the assertion below testing nothing

    // The literal href the fixed page renders, including the new query
    // string, fetched with SOMEONE ELSE's session — `portalHeadshotHref` only
    // changes what string gets rendered, never routes.ts or canReadUpload, so
    // this must refuse exactly as it did before the query string existed.
    await expect(
      headshotLoader({
        request: await signedInGet(`https://x.test${src}`, stranger),
        params: { personId: owner },
        context: {},
      } as unknown as Parameters<typeof headshotLoader>[0]),
    ).rejects.toMatchObject({ status: 404 });

    // COMPLEMENT: the owner's own session on that same href still works —
    // proves the refusal above is the stranger's identity talking, not a
    // route the query string broke for everyone.
    const ownResponse = await headshotLoader({
      request: await signedInGet(`https://x.test${src}`, owner),
      params: { personId: owner },
      context: {},
    } as unknown as Parameters<typeof headshotLoader>[0]);
    expect(ownResponse).toBeInstanceOf(Response);
    expect((ownResponse as Response).status).toBe(200);
  });
});
