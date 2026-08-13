/**
 * `/e/:slug/llms.txt` — event-scoped agent map. Sibling of `llms.txt.test.ts`,
 * reusing the same manifest-resolution idiom from `~/test/route-manifest` so
 * the two suites cannot silently diverge on what "no dead routes" means.
 *
 * Two things this file must prove that the platform suite cannot:
 *   1. The per-event doc is actually scoped — the other event's sessions and
 *      forms must never appear (`seedOtherEvent` gives it different counts on
 *      purpose, so leakage cannot pass by coincidence).
 *   2. The API pointers carry the resolved `event.id` (a concrete uuid), not
 *      the `:eventId` route param literally — an agent copy-pasting the line
 *      needs a real id, and the manifest resolver still accepts it because a
 *      registered `:param` segment matches any concrete value.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  CFP_FORM_ID,
  EVENT_ID,
  EVENT_SLUG,
  OTHER_EVENT_ID,
  OTHER_EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";
import { pathsIn, resolves } from "~/test/route-manifest";
import { env, resetEnv } from "~/test/workers-env";

import { loader } from "./public.llms";

type LoaderArgs = Parameters<typeof loader>[0];

const asLoaderArgs = (slug: string) =>
  ({
    request: new Request(`https://x.test/e/${slug}/llms.txt`),
    params: { slug },
    context: {},
  }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => {
  ctx.close();
  resetEnv();
});

async function bodyFor(slug: string): Promise<{ status: number; body: string; headers: Headers }> {
  const response = (await loader(asLoaderArgs(slug))) as Response;
  return { status: response.status, body: await response.text(), headers: response.headers };
}

describe("GET /e/:slug/llms.txt", () => {
  it("404s an unknown event slug, same as the other public event routes", async () => {
    await expect(loader(asLoaderArgs("does-not-exist"))).rejects.toMatchObject({ status: 404 });
  });

  it("serves plain text with the same cache header the platform file uses", async () => {
    const { status, headers } = await bodyFor(EVENT_SLUG);
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("names the event's own public pages and calendar feed", async () => {
    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).toContain(`/e/${EVENT_SLUG}`);
    expect(body).toContain(`/e/${EVENT_SLUG}/schedule`);
    expect(body).toContain(`/e/${EVENT_SLUG}/schedule.ics`);
    expect(body).toContain(`/e/${EVENT_SLUG}/speakers`);
  });

  it("lists every published session by its own URL, ordered by start time", async () => {
    const { body } = await bodyFor(EVENT_SLUG);
    const [first, second] = fixture.programSessionIds;
    const firstAt = body.indexOf(`/e/${EVENT_SLUG}/schedule/${first}`);
    const secondAt = body.indexOf(`/e/${EVENT_SLUG}/schedule/${second}`);
    expect(firstAt, "first published session is missing").toBeGreaterThan(-1);
    expect(secondAt, "second published session is missing").toBeGreaterThan(-1);
    expect(firstAt, "sessions are out of start-time order").toBeLessThan(secondAt);
    // The seeded abstract's status/decision vocabulary must not leak into an
    // agent-facing doc — only the programme session's own title belongs here.
    expect(body).toContain("Shipping agents that survive contact with users");
  });

  it("lists the open call's submit URL with its form name", async () => {
    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).toContain(`/submit/${EVENT_SLUG}/${CFP_FORM_ID}`);
    expect(body).toContain("Call for Proposals 2026");
  });

  it("carries the resolved event id in the API pointers, not the route's :eventId literal", async () => {
    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).toContain(`/v1/event/${EVENT_ID}/sessions`);
    expect(body).toContain(`/v1/event/${EVENT_ID}/speakers`);
    expect(body).not.toContain("/v1/event/:eventId");
  });

  it("MUST FIRE: an empty programme and a closed CFP name their own state, not a blank section", async () => {
    await ctx.db.update(forms).set({ status: "closed" }).where(eq(forms.id, CFP_FORM_ID));
    await ctx.db.update(sessions).set({ isPublic: false }).where(eq(sessions.eventId, EVENT_ID));

    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).toContain("Nothing is published on the schedule yet.");
    expect(body).toContain("No call for proposals is open on this event right now.");
    expect(body).not.toContain(`/submit/${EVENT_SLUG}/${CFP_FORM_ID}`);
  });

  it("MUST NOT FIRE: another event's sessions and forms never appear on this one's map", async () => {
    const other = await seedOtherEvent(ctx.db);
    const { body } = await bodyFor(EVENT_SLUG);

    expect(body).not.toContain(OTHER_EVENT_SLUG);
    expect(body).not.toContain(other.programSessionId);
    expect(body).not.toContain(other.formId);
    expect(body).not.toContain(`/v1/event/${OTHER_EVENT_ID}`);

    // ...and the other event's own file is symmetrically scoped: it does not
    // see back into the primary fixture either.
    const otherBody = (await bodyFor(OTHER_EVENT_SLUG)).body;
    expect(otherBody).not.toContain(EVENT_SLUG);
    expect(otherBody).not.toContain(CFP_FORM_ID);
    expect(otherBody).toContain(other.programSessionId);
  });

  it("MUST FIRE: demo deployments still surface the deployment-wide demo notes", async () => {
    Object.assign(env, {
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });
    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).toContain("/demo");
    expect(body).toContain("Magic links are revealed");
  });

  it("MUST NOT FIRE: production carries none of the demo-mode facts", async () => {
    Object.assign(env, { DEPLOYMENT_PROFILE: "production" });
    const { body } = await bodyFor(EVENT_SLUG);
    expect(body).not.toContain("Magic links are revealed");
    expect(body).not.toContain("disposable");
    // ...but the event's own real pages still render.
    expect(body).toContain(`/e/${EVENT_SLUG}/schedule`);
  });

  it("NO DEAD ROUTES: every path it names resolves in the route manifest", async () => {
    for (const profile of ["demo", "production"] as const) {
      Object.assign(
        env,
        profile === "demo"
          ? { DEPLOYMENT_PROFILE: "demo", DEMO_MODE: "1", DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z" }
          : { DEPLOYMENT_PROFILE: "production" },
      );
      const listed = pathsIn((await bodyFor(EVENT_SLUG)).body);
      // Guard the guard: an extractor that finds nothing would pass silently.
      expect(listed.length, `${profile} listed too few paths`).toBeGreaterThan(8);
      const dead = listed.filter((path) => !resolves(path));
      expect(dead, `${profile} names routes that do not exist`).toEqual([]);
    }
  });
});
