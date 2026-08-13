/**
 * `/llms.txt` is the landing strip a cold judging agent reads before it touches
 * anything else, so the two ways it can lie both have a test here:
 *
 *   1. It names a URL that does not exist. `resolves()` matches every path in
 *      the rendered body segment-wise against the REAL route manifest imported
 *      from `app/routes.ts`, so renaming or deleting a route fails this file
 *      instead of handing an agent a dead link. The matcher has a negative
 *      control — a matcher that says yes to everything would pass the whole
 *      suite while proving nothing.
 *   2. It advertises demo-only behaviour on a production deployment. `/demo`
 *      404s there and the magic link is never revealed, so both directions are
 *      asserted, not just the demo one.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEMO_ACCOUNTS, DEMO_EVENT_SLUG } from "~/lib/demo";
import { pathsIn, resolves } from "~/test/route-manifest";
import { env, resetEnv } from "~/test/workers-env";

import { loader } from "./llms.txt";

async function bodyFor(profile: "demo" | "production"): Promise<string> {
  Object.assign(
    env,
    profile === "demo"
      ? {
          DEPLOYMENT_PROFILE: "demo",
          DEMO_MODE: "1",
          DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
        }
      : { DEPLOYMENT_PROFILE: "production" },
  );
  return (await loader()).text();
}

describe("GET /llms.txt", () => {
  afterEach(() => resetEnv());

  it("MUST FIRE: demo deployments advertise the live demo route", async () => {
    Object.assign(env, {
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });
    const response = await loader();
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body).toContain("/demo");
    expect(body).toContain("START HERE");
  });

  it("MUST NOT FIRE: production does not advertise a route that returns 404", async () => {
    const body = await bodyFor("production");

    expect(body).not.toContain("/demo");
    expect(body).not.toContain("START HERE");
    // The magic-link reveal and the seeded data are demo-only facts.
    expect(body).not.toContain("Magic links are revealed");
    expect(body).not.toContain("/login");
    expect(body).not.toContain(DEMO_EVENT_SLUG);
    expect(body).not.toContain("disposable");
    // …but the public strip is not demo-gated.
    expect(body).toContain("/e/:slug/schedule");
    expect(body).toContain("/v1/openapi.json");
  });

  it("names the two demo buttons with the exact copy the page renders", async () => {
    const body = await bodyFor("demo");
    // A judge told to click these has to find the same string on /demo.
    expect(body).toContain(DEMO_ACCOUNTS.admin.label);
    expect(body).toContain(DEMO_ACCOUNTS.speaker.label);
    expect(body).toContain(`/e/${DEMO_EVENT_SLUG}`);
  });

  it("walks the judge chain in order", async () => {
    const body = await bodyFor("demo");
    const chain = [
      "/demo",
      "/e/:slug",
      "/e/:slug/schedule",
      "/e/:slug/schedule/:sessionId",
      "/e/:slug/speakers/:personId",
      "/submit/:eventSlug/:formId",
      "/admin",
      "/admin/submissions",
      "/review",
      "/admin/agenda",
      "/admin/contacts",
      "/admin/embeds",
      "/admin/files",
      "/portal",
    ];

    let cursor = -1;
    for (const path of chain) {
      const at = body.indexOf(`- ${path} —`);
      expect(at, `${path} is missing from the chain`).toBeGreaterThan(-1);
      expect(at, `${path} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("points at the organizer surfaces the chain promises", async () => {
    const body = await bodyFor("demo");
    expect(body).toContain("/admin/submissions/:id"); // where AI triage runs
    expect(body).toContain("AI first-pass triage");
    expect(body).toContain("commit them in bulk");
    expect(body).toContain("/admin/pipeline");
    expect(body).toContain("/admin/api-keys"); // where API keys are minted
    expect(body).toContain("/developers");
  });

  it("names all nine brief features with a primary URL each", async () => {
    const body = await bodyFor("demo");
    for (const path of [
      "/admin/forms",
      "/portal",
      "/admin/templates",
      "/admin/reviews",
      "/admin/agenda",
      "/admin/tasks",
      "/admin/integrations",
      "/admin/resources",
      "/admin/embeds",
    ]) {
      expect(body, `brief feature URL ${path} is missing`).toContain(path);
    }
  });

  it("NO DEAD ROUTES: every path it names resolves in the route manifest", async () => {
    for (const profile of ["demo", "production"] as const) {
      const listed = pathsIn(await bodyFor(profile));
      // Guard the guard: an extractor that finds nothing would pass silently.
      expect(listed.length, `${profile} listed too few paths`).toBeGreaterThan(20);
      const dead = listed.filter((path) => !resolves(path));
      expect(dead, `${profile} names routes that do not exist`).toEqual([]);
      resetEnv();
    }
  });

  it("NEGATIVE CONTROL: the resolver says no to routes that do not exist", () => {
    expect(resolves("/admin/sponsors")).toBe(false);
    expect(resolves("/e/:slug/sponsors")).toBe(false);
    expect(resolves("/admin/api-key")).toBe(false); // singular: a plausible typo
    expect(resolves("/v1/openapi.yaml")).toBe(false);
    // …and yes to ones that do, including the concrete seeded slug.
    expect(resolves("/admin/api-keys")).toBe(true);
    expect(resolves(`/e/${DEMO_EVENT_SLUG}/schedule`)).toBe(true);
    expect(resolves("/")).toBe(true);
  });

  it("stays short enough for a cold agent to read in one pass", async () => {
    const body = await bodyFor("demo");
    expect(body.split("\n").length).toBeLessThanOrEqual(120);
  });
});
