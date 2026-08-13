/**
 * A missing speaker is a 404, not a 200 with an apology on it.
 *
 * `/admin/speakers/<bogus-id>` rendered a good "no such person in this event"
 * page and returned HTTP 200 while doing it — the version of this bug that
 * survives review, because a human sees a correct screen and everything reading
 * status codes instead of pixels sees success. PR #145 fixed exactly this shape
 * on /admin/submissions/:id and named THIS route as still carrying it; this is
 * that fix's sibling, deliberately using the same mechanism and the same tests.
 *
 * The loader keeps returning the friendly payload, now with the status it
 * always meant. `data(payload, { status: 404 })` says that without throwing, so
 * the route's own component still renders — `throw new Response(404)` would
 * hand the screen to the root ErrorBoundary and LOSE the copy pinned below.
 *
 * Both halves are asserted: a bogus id is a 404 AND still renders the friendly
 * body; a real speaker is untouched at 200 with their content. A fix that 404s
 * everything passes the first half alone.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { SpeakerView, loader, speakerLoaderPayload } from "./admin.speaker";

type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** The raw loader return — `data()` wrapper and all. */
async function rawLoad(id: string, url?: string) {
  const request = await signedInGet(url ?? `https://x.test/admin/speakers/${id}`, fixture.adminId);
  return loader({ request, params: { id }, context: {} } as unknown as LoaderArgs);
}

/**
 * React Router's `data()` returns `{ type, data, init }`; a plain object means
 * the default 200. Reading the status this way — rather than trusting the
 * shape — is what lets the same helper assert BOTH branches.
 */
function statusOf(result: unknown): number {
  if (result && typeof result === "object" && "init" in result) {
    return (result as { init?: ResponseInit }).init?.status ?? 200;
  }
  return 200;
}

/* ─────────────────────────── must-fire: the missing person answers 404 ── */

describe("a speaker who does not exist", () => {
  it("returns 404 for junk in the id segment", async () => {
    expect(statusOf(await rawLoad("no-such-person"))).toBe(404);
  });

  it("returns 404 for a well-formed id that is not a person", async () => {
    expect(statusOf(await rawLoad("00000000-0000-4000-8000-0000000dead0"))).toBe(404);
  });

  it("still renders the friendly page, not a bare error", async () => {
    // The status is the fix; the body is what must NOT change. Swapping the
    // loader to `throw new Response(null, { status: 404 })` would pass the
    // assertions above and replace this screen with the root ErrorBoundary.
    const result = await rawLoad("no-such-person");
    expect(statusOf(result)).toBe(404);

    const html = renderToStaticMarkup(<SpeakerView {...speakerLoaderPayload(result)} />);
    expect(html).toContain("No such person in this event.");
  });
});

/* ───────────────────────── must-not-fire: a real speaker is untouched ── */

describe("a speaker who does exist", () => {
  it("stays 200", async () => {
    expect(statusOf(await rawLoad(fixture.speakerIds[0]))).toBe(200);
  });

  it("still returns their profile payload", async () => {
    // The control for `speakerLoaderPayload`: if the fix wrapped the success
    // path too and the helper unwrapped it silently, the status assertion above
    // would be the only thing standing, so pin the content as well.
    const payload = speakerLoaderPayload(await rawLoad(fixture.speakerIds[0]));
    expect(payload.speaker?.name).toBe("Sam Speaker");
  });

  it("renders the profile, not the not-found copy", async () => {
    const html = renderToStaticMarkup(
      <SpeakerView {...speakerLoaderPayload(await rawLoad(fixture.speakerIds[0]))} />,
    );
    expect(html).not.toContain("No such person in this event.");
    expect(html).toContain("Sam Speaker");
  });
});

/* ──────────── must-not-fire: an instance with no event is an empty state ── */

describe("no event set up yet", () => {
  it("stays 200, because nothing is missing — there is just nothing yet", async () => {
    // An event-less request is a cold start, not a bad URL. 404-ing it would
    // tell an uptime check the app is broken on the day it is installed. The
    // seeded event still exists, so a 200 here is the `!event` branch talking
    // and not an empty database.
    const result = await rawLoad(
      fixture.speakerIds[0],
      "https://x.test/admin/speakers/x?event=nope",
    );
    expect(statusOf(result)).toBe(200);
  });
});
