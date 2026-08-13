import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { demoAccessEnabled, demoDeploymentExpired } from "./demo-access";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const future = "2026-08-09T12:00:00.000Z";

describe("demoAccessEnabled — must NOT enable demo auth", () => {
  it.each([
    { deploymentProfile: "production", demoMode: "1", expiresAt: future },
    { deploymentProfile: undefined, demoMode: "1", expiresAt: future },
    { deploymentProfile: "demo", demoMode: undefined, expiresAt: future },
    { deploymentProfile: "preview", demoMode: "true", expiresAt: future },
    { deploymentProfile: "demo", demoMode: "1", expiresAt: undefined },
    { deploymentProfile: "demo", demoMode: "1", expiresAt: "not-a-date" },
    { deploymentProfile: "demo", demoMode: "1", expiresAt: "2026-08-08T12:00:00.000Z" },
  ])("fails closed for %#", (input) => {
    expect(demoAccessEnabled({ ...input, now: NOW })).toBe(false);
  });
});

describe("demoAccessEnabled — explicitly live disposable demo", () => {
  it.each(["1", "true", " TRUE "])("accepts explicit flag %j before expiry", (demoMode) => {
    expect(
      demoAccessEnabled({
        deploymentProfile: "demo",
        demoMode,
        expiresAt: future,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("does not accept a false flag", () => {
    expect(
      demoAccessEnabled({
        deploymentProfile: "demo",
        demoMode: "0",
        expiresAt: future,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("demoDeploymentExpired", () => {
  it.each([
    undefined,
    "not-a-date",
    "2026-08-08T11:59:59.999Z",
    "2026-08-08T12:00:00.000Z",
  ])("closes a demo-profile Worker for deadline %j", (expiresAt) => {
    expect(
      demoDeploymentExpired({ deploymentProfile: "demo", expiresAt, now: NOW }),
    ).toBe(true);
  });

  it("keeps a live demo open before its deadline", () => {
    expect(
      demoDeploymentExpired({ deploymentProfile: "demo", expiresAt: future, now: NOW }),
    ).toBe(false);
  });

  it("never applies the demo expiry kill switch to production", () => {
    expect(
      demoDeploymentExpired({
        deploymentProfile: "production",
        expiresAt: "2020-01-01T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("repository deployment boundary", () => {
  const productionConfig = readFileSync(
    fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    "utf8",
  );
  const demoTemplate = readFileSync(
    fileURLToPath(new URL("../../wrangler.demo.example.jsonc", import.meta.url)),
    "utf8",
  );
  const demoRoute = readFileSync(
    fileURLToPath(new URL("../routes/auth.demo.tsx", import.meta.url)),
    "utf8",
  );
  const workerEntry = readFileSync(
    fileURLToPath(new URL("../../workers/app.ts", import.meta.url)),
    "utf8",
  );

  it("ships the default Wrangler config as production with demo auth off", () => {
    expect(productionConfig).toMatch(/"DEPLOYMENT_PROFILE"\s*:\s*"production"/);
    expect(productionConfig).toMatch(/"DEMO_MODE"\s*:\s*"0"/);
    expect(productionConfig).not.toContain("DEMO_EXPIRES_AT");
  });

  it("keeps the opt-in and required expiry in a disposable template", () => {
    expect(demoTemplate).toMatch(/"name"\s*:\s*"callboard-disposable-demo"/);
    expect(demoTemplate).toMatch(/"DEPLOYMENT_PROFILE"\s*:\s*"demo"/);
    expect(demoTemplate).toMatch(/"DEMO_MODE"\s*:\s*"1"/);
    expect(demoTemplate).toContain("DEMO_EXPIRES_AT");
    expect(demoTemplate).toContain("REPLACE_WITH_DISPOSABLE_DEMO_D1_DATABASE_ID");
    // The template must never reuse the default config's database — read the
    // guarded value from wrangler.jsonc instead of embedding an id here, so the
    // guard tracks whatever an operator pastes into the default config.
    const defaultDatabaseId = productionConfig.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
    expect(defaultDatabaseId).toBeTruthy();
    expect(demoTemplate).not.toContain(defaultDatabaseId as string);
  });

  it("gates both demo route entry points before demoSignIn can mint a session", () => {
    expect(demoRoute.match(/assertDemoMode\(\);/g)).toHaveLength(2);
    const action = demoRoute.slice(demoRoute.indexOf("export async function action"));
    expect(action.indexOf("assertDemoMode();")).toBeGreaterThanOrEqual(0);
    expect(action.indexOf("assertDemoMode();")).toBeLessThan(action.indexOf("demoSignIn("));
  });

  it("gates fetch and scheduled work when the disposable deployment expires", () => {
    expect(workerEntry.match(/isDemoDeploymentExpired\(\)/g)).toHaveLength(2);
    const scheduled = workerEntry.slice(workerEntry.indexOf("async scheduled"));
    expect(scheduled.indexOf("isDemoDeploymentExpired()")).toBeGreaterThanOrEqual(0);
    expect(scheduled.indexOf("isDemoDeploymentExpired()")).toBeLessThan(
      scheduled.indexOf("jobsForCron("),
    );
  });
});
