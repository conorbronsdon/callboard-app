/**
 * Where magic links point.
 *
 * Every lane gets its own `wrangler versions upload` preview host, and they all
 * share the deployed `APP_URL` var. Building links from `APP_URL` first sent
 * every preview login to production — where the token row does not exist — so
 * the request origin has to win when there is a request.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { issueMagicLink } from "~/lib/auth/auth.server";
import { installTestDb, type TestDbContext } from "~/test/db";

import { appUrl, organizersEntryHref } from "./env.server";

const PRODUCTION = "https://callboard.example.workers.dev";
const PREVIEW = "https://9f2c1b0a-callboard.example.workers.dev";

let ctx: TestDbContext;

beforeEach(() => {
  ctx = installTestDb({ APP_URL: PRODUCTION });
});
afterEach(() => ctx.close());

describe("appUrl", () => {
  it("must fire: a request from a preview host wins over APP_URL", () => {
    expect(appUrl(new Request(`${PREVIEW}/login`))).toBe(PREVIEW);
  });

  it("must NOT fire: with no request it falls back to APP_URL", () => {
    expect(appUrl()).toBe(PRODUCTION);
    expect(appUrl(null)).toBe(PRODUCTION);
  });

  it("trims a trailing slash off the configured fallback", () => {
    ctx.close();
    ctx = installTestDb({ APP_URL: `${PRODUCTION}/` });
    expect(appUrl()).toBe(PRODUCTION);
  });

  it("fails loudly when there is neither a request nor APP_URL", () => {
    ctx.close();
    ctx = installTestDb();
    expect(() => appUrl()).toThrow(/APP_URL/);
  });
});

describe("organizersEntryHref", () => {
  it("MUST NOT FIRE: production (no DEPLOYMENT_PROFILE set) points at /admin", () => {
    ctx.close();
    ctx = installTestDb();
    expect(organizersEntryHref()).toBe("/admin");
  });

  it("MUST FIRE: a live disposable demo points at the one-click entry instead", () => {
    ctx.close();
    ctx = installTestDb({
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });
    expect(organizersEntryHref()).toBe("/demo");
  });

  it("MUST NOT FIRE: a demo profile with only ONE of the two flags still points at /admin", () => {
    // demoAccessEnabled requires DEPLOYMENT_PROFILE=demo AND DEMO_MODE AND an
    // unexpired DEMO_EXPIRES_AT together — the same fail-closed boundary
    // isDemoMode() already enforces. A doorway that jumped to /demo on a
    // partial signal would hand judges a broken link on a real deployment
    // that merely forgot to unset DEMO_MODE.
    ctx.close();
    ctx = installTestDb({ DEPLOYMENT_PROFILE: "demo" });
    expect(organizersEntryHref()).toBe("/admin");
  });

  it("MUST NOT FIRE: an expired disposable demo falls back to /admin", () => {
    ctx.close();
    ctx = installTestDb({
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2020-01-01T00:00:00.000Z",
    });
    expect(organizersEntryHref()).toBe("/admin");
  });
});

describe("issueMagicLink", () => {
  it("mints a link on the preview host the request came from", async () => {
    const issued = await issueMagicLink({
      request: new Request(`${PREVIEW}/login`),
      email: "preview@example.com",
    });

    expect(issued.url.startsWith(`${PREVIEW}/auth/verify?token=`)).toBe(true);
    expect(issued.url).not.toContain(PRODUCTION);
  });

  it("mints a production link when the request comes from production", async () => {
    const issued = await issueMagicLink({
      request: new Request(`${PRODUCTION}/login`),
      email: "prod@example.com",
    });

    expect(issued.url.startsWith(`${PRODUCTION}/auth/verify?token=`)).toBe(true);
  });

  it("carries redirectTo through to the link", async () => {
    const issued = await issueMagicLink({
      request: new Request(`${PREVIEW}/login`),
      email: "redirect@example.com",
      redirectTo: "/portal/tasks",
    });

    expect(new URL(issued.url).searchParams.get("redirectTo")).toBe("/portal/tasks");
  });
});
