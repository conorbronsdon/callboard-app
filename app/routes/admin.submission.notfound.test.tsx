/**
 * A missing abstract is a 404, not a 200 with an apology on it.
 *
 * `/admin/submissions/<bogus-id>` rendered a good "does not exist in this
 * event" page — and returned HTTP 200 while doing it. The page was right and
 * the status line was a lie, which is the version of this bug that survives
 * review: a human sees a correct screen, and everything that reads status codes
 * instead of pixels sees success. Uptime checks, `curl -f`, link crawlers, the
 * browser's own history heuristics and any future error budget all take the 200
 * at face value.
 *
 * The loader keeps returning the friendly payload; it just returns it with the
 * status it always meant. `data(payload, { status: 404 })` is the React Router
 * way to say that without throwing, so the route's own component still renders
 * — as opposed to `throw new Response(404)`, which would hand the screen to the
 * root ErrorBoundary and LOSE the friendly copy this test also pins.
 *
 * Both halves are asserted: a bogus id is a 404 AND still renders the friendly
 * body; a real id is untouched at 200 with its content. A fix that 404s
 * everything passes the first half alone.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { SubmissionDetailView, loader, submissionLoaderPayload } from "./admin.submission";

type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** The raw loader return — `data()` wrapper and all. */
async function rawLoad(id: string) {
  const request = await signedInGet(`https://x.test/admin/submissions/${id}`, fixture.adminId);
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

/** The payload, whichever branch produced it. Shared with the route module. */
const payloadOf = submissionLoaderPayload;

/* ────────────────────────────── must-fire: the missing row answers 404 ── */

describe("an abstract that does not exist", () => {
  it("returns 404 for junk in the id segment", async () => {
    expect(statusOf(await rawLoad("no-such-id"))).toBe(404);
  });

  it("returns 404 for a real session id that is not an abstract", async () => {
    // A program session has no drill-in. Same page, same reasoning: the URL
    // does not address an abstract, so it is not found.
    expect(statusOf(await rawLoad(fixture.programSessionIds[0]))).toBe(404);
  });

  it("still renders the friendly page, not a bare error", async () => {
    // The status is the fix; the body is what must NOT change. Swapping the
    // loader to `throw new Response(null, { status: 404 })` would pass the
    // assertions above and replace this screen with the root ErrorBoundary.
    const result = await rawLoad("no-such-id");
    expect(statusOf(result)).toBe(404);

    const html = renderToStaticMarkup(<SubmissionDetailView {...payloadOf(result)} />);
    expect(html).toContain("does not exist in this event");
  });
});

/* ──────────────────────────── must-not-fire: a real abstract is untouched ── */

describe("an abstract that does exist", () => {
  it("stays 200", async () => {
    expect(statusOf(await rawLoad(fixture.abstractIds[0]))).toBe(200);
  });

  it("still returns its detail payload", async () => {
    // The control for `payloadOf`: if the fix wrapped the success path too and
    // this helper unwrapped it silently, the status assertion above would be
    // the only thing standing, so pin the content as well.
    const payload = payloadOf(await rawLoad(fixture.abstractIds[0]));
    expect(payload.detail?.title).toBe("Shipping agents that survive contact with users");
  });

  it("renders the abstract, not the not-found copy", async () => {
    const html = renderToStaticMarkup(
      <SubmissionDetailView {...payloadOf(await rawLoad(fixture.abstractIds[0]))} />,
    );
    expect(html).not.toContain("does not exist in this event");
    expect(html).toContain("Shipping agents that survive contact with users");
  });
});
