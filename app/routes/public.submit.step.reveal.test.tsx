/**
 * CFP-05: the CFP wizard's OWN reveal surface, not the shared helper.
 *
 * auth.login.reveal.test.tsx pins `shouldRevealMagicLink()` through /login.
 * That is necessary but not sufficient: the account step of the public wizard
 * calls the helper at its own call site, and a mutation that drops the demo
 * carve-out there alone (`const reveal = isDev();`, or `false`) leaves every
 * other test green while re-opening the exact CFP-05 gap — on the judged
 * demo Worker no new speaker identity could ever be created.
 *
 * Same discipline as the login file: every deployed-case assertion stubs
 * `MODE=production` first, because under Vitest `isDev()` is true and the
 * whole file would otherwise pass against the unpatched code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_SLUG, seedDemoFixture } from "~/test/fixtures";

import { action } from "./public.submit.step";

type ActionArgs = Parameters<typeof action>[0];

const HOUR = 3_600_000;
const future = () => new Date(Date.now() + 6 * HOUR).toISOString();

/** Exactly what `wrangler.demo.example.jsonc` sets on a disposable demo. */
const DEMO_ENV = {
  DEPLOYMENT_PROFILE: "demo",
  DEMO_MODE: "1",
  DEMO_EXPIRES_AT: future(),
};

/** A deployed, ordinary Worker: none of the three demo signals. */
const PRODUCTION_ENV = {};

let ctx: TestDbContext;

async function install(overrides: Record<string, unknown>) {
  ctx?.close();
  ctx = installTestDb({ APP_URL: "https://callboard.test", ...overrides });
  await seedDemoFixture(ctx.db);
}

async function submitAccountStep() {
  const body = new FormData();
  body.set("intent", "next");
  body.set("fullName", "Reveal Probe");
  body.set("email", "reveal.probe@example.com");
  const request = new Request(
    `https://callboard.test/submit/${EVENT_SLUG}/${CFP_FORM_ID}/account`,
    { method: "POST", body },
  );
  const args = {
    request,
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID, step: "account" },
    context: {},
  } as unknown as ActionArgs;
  const result = await action(args);
  // React Router data() wraps the payload; unwrap either shape.
  return (result as { data?: unknown }).data ?? result;
}

beforeEach(() => {
  ctx = installTestDb({ APP_URL: "https://callboard.test" });
});
afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
});

describe("CFP wizard account step magic-link reveal", () => {
  it("must fire: a deployed DEMO Worker reveals the link on the wizard itself", async () => {
    vi.stubEnv("MODE", "production");
    await install(DEMO_ENV);
    const payload = (await submitAccountStep()) as {
      magicLink: string | null;
      magicLinkReveal: string | null;
    };
    expect(payload.magicLink).toMatch(/\/auth\/verify\?token=.+/);
    expect(payload.magicLinkReveal).toBe("demo");
  });

  it("must NOT fire: a deployed non-demo Worker reveals nothing", async () => {
    vi.stubEnv("MODE", "production");
    await install(PRODUCTION_ENV);
    const payload = (await submitAccountStep()) as {
      magicLink: string | null;
      magicLinkReveal: string | null;
    };
    expect(payload.magicLink).toBeNull();
    expect(payload.magicLinkReveal).toBeNull();
  });

  it("dev still reveals, labelled dev not demo", async () => {
    // No MODE stub: Vitest's MODE keeps isDev() true, the local-dev reality.
    await install(PRODUCTION_ENV);
    const payload = (await submitAccountStep()) as {
      magicLink: string | null;
      magicLinkReveal: string | null;
    };
    expect(payload.magicLink).toMatch(/\/auth\/verify\?token=.+/);
    expect(payload.magicLinkReveal).toBe("dev");
  });
});
