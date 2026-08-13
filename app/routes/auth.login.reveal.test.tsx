/**
 * CFP-05 / SPK-07: may the magic link be printed on screen?
 *
 * The gate moved from `isDev()` to `isDev() || isDemoMode()` so a judge on the
 * disposable demo Worker can finish a sign-in that the console mailer would
 * otherwise swallow. That widening is only safe if a DEPLOYED, NON-DEMO
 * configuration still reveals nothing — and that is the case a test run under
 * Vitest cannot see by default, because `isDev()` reads `import.meta.env.MODE`,
 * which is `"test"` here and therefore true for every case.
 *
 * So every assertion below pins `MODE=production` first (`vi.stubEnv`). Without
 * it the whole file would pass on the UNPATCHED code as well — a green check
 * that cannot go red. The dev case is asserted separately, with the stub
 * removed, so "we broke local dev" also fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shouldRevealMagicLink } from "~/lib/auth/auth.server";
import { installTestDb, type TestDbContext } from "~/test/db";

import { action, loader } from "./auth.login";

type ActionArgs = Parameters<typeof action>[0];
const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const LOGIN = "https://callboard.test/login";
const HOUR = 3_600_000;
const future = () => new Date(Date.now() + 6 * HOUR).toISOString();
const past = () => new Date(Date.now() - HOUR).toISOString();

/** Exactly what `wrangler.demo.example.jsonc` sets on a disposable demo. */
const DEMO_ENV = {
  DEPLOYMENT_PROFILE: "demo",
  DEMO_MODE: "1",
  DEMO_EXPIRES_AT: future(),
};

/** A deployed, ordinary Worker: none of the three demo signals. */
const PRODUCTION_ENV = {};

let ctx: TestDbContext;

function install(overrides: Record<string, unknown>) {
  ctx?.close();
  ctx = installTestDb({ APP_URL: "https://callboard.test", ...overrides });
}

beforeEach(() => {
  ctx = installTestDb({ APP_URL: "https://callboard.test" });
});
afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
});

describe("shouldRevealMagicLink", () => {
  it("must fire: a deployed DEMO Worker reveals the link", () => {
    vi.stubEnv("MODE", "production");
    install(DEMO_ENV);
    // The control for the control: the stub really did take effect, so a pass
    // below is the demo gate and not `isDev()` leaking through.
    expect(import.meta.env.MODE).toBe("production");
    expect(shouldRevealMagicLink()).toBe(true);
  });

  it("must NOT fire: a deployed non-demo Worker never reveals the link", () => {
    vi.stubEnv("MODE", "production");
    install(PRODUCTION_ENV);
    expect(shouldRevealMagicLink()).toBe(false);
  });

  it("must NOT fire: each demo signal on its own is not enough", () => {
    vi.stubEnv("MODE", "production");
    for (const partial of [
      { DEMO_MODE: "1" },
      { DEPLOYMENT_PROFILE: "demo" },
      { DEPLOYMENT_PROFILE: "demo", DEMO_MODE: "1" }, // no deadline
      { DEPLOYMENT_PROFILE: "demo", DEMO_MODE: "1", DEMO_EXPIRES_AT: past() }, // expired
      { DEPLOYMENT_PROFILE: "production", DEMO_MODE: "1", DEMO_EXPIRES_AT: future() },
    ]) {
      install(partial);
      expect(shouldRevealMagicLink(), JSON.stringify(partial)).toBe(false);
    }
  });

  it("must still fire: local dev is unchanged with no demo vars at all", () => {
    install(PRODUCTION_ENV);
    expect(import.meta.env.MODE).not.toBe("production");
    expect(shouldRevealMagicLink()).toBe(true);
  });
});

describe("/login surfaces the link only where it is allowed", () => {
  async function post(email = "ingrid.speaker@example.com") {
    const request = new Request(LOGIN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    });
    return action(args(request));
  }

  it("must fire: the demo login response carries a usable link", async () => {
    vi.stubEnv("MODE", "production");
    install(DEMO_ENV);
    const result = await post();
    expect(result.ok).toBe(true);
    // Asserted by VALUE, not by truthiness: a caption is not a login.
    expect(result.devLink).toMatch(/^https:\/\/callboard\.test\/auth\/verify\?token=.+/);
  });

  it("must NOT fire: the production login response carries no link", async () => {
    vi.stubEnv("MODE", "production");
    install(PRODUCTION_ENV);
    const result = await post();
    expect(result.ok).toBe(true);
    expect(result.devLink).toBeNull();
  });

  it("must NOT fire: a rejected email issues nothing in demo mode either", async () => {
    vi.stubEnv("MODE", "production");
    install(DEMO_ENV);
    const request = new Request(LOGIN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "not-an-email" }).toString(),
    });
    const result = await action(args(request));
    expect(result.ok).toBe(false);
    expect(result.devLink).toBeNull();
  });

  it("the loader tells the page which caption to print", async () => {
    vi.stubEnv("MODE", "production");
    install(DEMO_ENV);
    const demo = await loader({
      request: new Request(LOGIN),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(demo.demoMode).toBe(true);

    install(PRODUCTION_ENV);
    const production = await loader({
      request: new Request(LOGIN),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(production.demoMode).toBe(false);
  });
});
