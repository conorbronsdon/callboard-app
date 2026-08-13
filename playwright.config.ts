import { defineConfig, devices } from "@playwright/test";

/**
 * WS1b golden-path smoke for the public submission wizard.
 *
 * MOBILE VIEWPORT IS THE DEFAULT, not an extra project: the CFP form is the
 * surface a speaker opens on a phone from a conference link (PLAN §4 WS1b —
 * "SSR, mobile-first"). 375×812 is an iPhone SE/13 mini, the narrowest device
 * worth supporting.
 *
 * `npm run e2e` creates a one-use Cloudflare persistence root, migrates and
 * seeds it, then gives the same path to this dev server. The runner removes all
 * D1/R2 state in a finally block.
 */
/**
 * This lane's dedicated dev port. Parallel worktrees must NOT share 5173.
 * Override with CALLBOARD_E2E_PORT if 5191 is taken too.
 */
const PORT = Number(process.env.CALLBOARD_E2E_PORT ?? 5191);
const explicitBaseURL = process.env.CALLBOARD_E2E_URL;
const e2ePersistencePath = process.env.CALLBOARD_E2E_PERSIST_TO;
const baseURL = explicitBaseURL ?? `http://localhost:${PORT}`;

if (!explicitBaseURL && !e2ePersistencePath) {
  throw new Error(
    "Local Playwright requires disposable persistence. Run `npm run e2e` instead of invoking Playwright directly.",
  );
}

if (explicitBaseURL) {
  const target = new URL(explicitBaseURL);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (!loopback) {
    throw new Error(
      "Refusing to run mutation-heavy Playwright tests against a remote URL. " +
        "This suite cannot verify the remote Worker's mail driver or reset its data. " +
        "Run it only against the local server.",
    );
  }
}

const localWebServer = {
  command: `npm run dev -- --port ${PORT} --strictPort`,
  url: `http://localhost:${PORT}/`,
  /*
   * A test run must never reach a real mail provider. This does NOT depend on
   * RESEND_API_KEY being absent — a developer who has exercised WS5 has a real
   * key in .dev.vars, which the dev server reads.
   */
  env: {
    MAIL_DRIVER: "console",
    CALLBOARD_E2E_PERSIST_TO: e2ePersistencePath!,
    // The suite mutates seeded local data and exercises /demo. Opt in explicitly;
    // the checked-in/default Worker config remains production and closed.
    DEPLOYMENT_PROFILE: "demo",
    DEMO_MODE: "1",
    // Local-only expiry keeps the production boundary identical to deployed demos.
    DEMO_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
  },
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: "pipe" as const,
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    viewport: { width: 375, height: 812 },
    isMobile: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile-375",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  // Direct Playwright may target an explicitly managed loopback server for
  // debugging, but only the npm runner owns/reset state and counts as release evidence.
  webServer: explicitBaseURL ? undefined : localWebServer,
});
