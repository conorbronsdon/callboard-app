import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  demoExpired,
  executePlan,
  inspectDemoConfig,
  inspectIsolatedDemoConfig,
  resetPlan,
} from "./demo-lifecycle-lib.mjs";
import { runDemoReset } from "./demo-lifecycle-runner.mjs";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const validConfig = `
{
  "name": "callboard-disposable-demo-judges",
  "vars": {
    "DEPLOYMENT_PROFILE": "demo",
    "DEMO_MODE": "1",
    "MAIL_DRIVER": "console",
    "DEMO_EXPIRES_AT": "2026-08-10T12:00:00.000Z"
  },
  "d1_databases": [{ "binding": "DB", "database_name": "callboard-disposable-demo-db" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "callboard-disposable-demo-files" }]
}`;

const isolatedConfig = `
{
  "name": "callboard-disposable-demo-judges",
  "vars": {
    "APP_URL": "https://callboard-disposable-demo.example.test",
    "DEPLOYMENT_PROFILE": "demo",
    "DEMO_MODE": "1",
    "MAIL_DRIVER": "console",
    "DEMO_EXPIRES_AT": "2026-08-10T12:00:00.000Z"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "callboard-disposable-demo-db",
    "database_id": "isolated-demo-id"
  }],
  "r2_buckets": [{
    "binding": "FILES",
    "bucket_name": "callboard-disposable-demo-files"
  }]
}
`;

const defaultConfig = `
{
  "name": "callboard",
  "vars": { "APP_URL": "https://callboard.example.test" },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "callboard-db",
    "database_id": "production-id"
  }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "callboard-files" }]
}
`;

function withResetConfig(source, callback) {
  const root = mkdtempSync(join(tmpdir(), "callboard-demo-reset-"));
  writeFileSync(join(root, "wrangler.demo.jsonc"), source);
  writeFileSync(join(root, "wrangler.jsonc"), defaultConfig);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("inspectDemoConfig — must fire", () => {
  it("accepts only a short-lived, isolated, console-mail demo config", () => {
    expect(
      inspectDemoConfig({ configPath: "/tmp/wrangler.demo.jsonc", source: validConfig, now: NOW }),
    ).toMatchObject({
      databaseName: "callboard-disposable-demo-db",
      bucketName: "callboard-disposable-demo-files",
    });
  });
});

describe("inspectDemoConfig — must not fire", () => {
  it.each([
    ["production config path", "/tmp/wrangler.jsonc", validConfig],
    ["production D1 target", "/tmp/wrangler.demo.jsonc", validConfig.replace("callboard-disposable-demo-db", "callboard-db")],
    ["real email", "/tmp/wrangler.demo.jsonc", validConfig.replace('"console"', '"resend"')],
    ["missing expiry", "/tmp/wrangler.demo.jsonc", validConfig.replace('"2026-08-10T12:00:00.000Z"', '""')],
    ["expired", "/tmp/wrangler.demo.jsonc", validConfig.replace("2026-08-10", "2026-08-07")],
    ["overlong lifetime", "/tmp/wrangler.demo.jsonc", validConfig.replace("2026-08-10", "2026-08-20")],
    ["placeholder", "/tmp/wrangler.demo.jsonc", validConfig.replace("judges", "REPLACE_JUDGES")],
  ])("rejects %s", (_name, configPath, source) => {
    expect(() => inspectDemoConfig({ configPath, source, now: NOW })).toThrow();
  });
});

describe("reset isolation preflight", () => {
  it("rejects a demo-looking config bound to production D1 before any executor runs", () => {
    const calls = [];
    const source = isolatedConfig.replace("isolated-demo-id", "production-id");

    expect(() => {
      const inspected = inspectIsolatedDemoConfig({
        configPath: "/tmp/wrangler.demo.jsonc",
        source,
        defaultSource: defaultConfig,
        now: NOW,
      });
      executePlan(resetPlan(inspected), (step) => calls.push(step.label));
    }).toThrow(/must not overlap/);
    expect(calls).toEqual([]);
  });

  it("allows an isolated config to reach the reset executor plan", () => {
    const calls = [];
    const inspected = inspectIsolatedDemoConfig({
      configPath: "/tmp/wrangler.demo.jsonc",
      source: isolatedConfig,
      defaultSource: defaultConfig,
      now: NOW,
    });
    executePlan(resetPlan(inspected), (step) => calls.push(step.label));
    expect(calls).toEqual([
      "apply migrations",
      "wipe mutable D1 state",
      "restore deterministic seed",
    ]);
  });

  it("rejects invalid config before any child process", () => {
    withResetConfig(
      isolatedConfig.replace("isolated-demo-id", "production-id"),
      (root) => {
        const calls = [];
        expect(() =>
          runDemoReset({
            argv: ["--config=wrangler.demo.jsonc", "--execute"],
            root,
            now: NOW,
            log() {},
            spawn(...args) {
              calls.push(args);
              return { status: 0 };
            },
          }),
        ).toThrow(/must not overlap/);
        expect(calls).toEqual([]);
      },
    );
  });

  it("uses repo-local Wrangler and stops after a failed migration", () => {
    withResetConfig(isolatedConfig, (root) => {
      const calls = [];
      expect(() =>
        runDemoReset({
          argv: ["--config=wrangler.demo.jsonc", "--execute"],
          root,
          now: NOW,
          log() {},
          spawn(command, args, options) {
            calls.push({ command, args, options });
            return { status: 23 };
          },
        }),
      ).toThrow(/exit code 23/);

      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(process.execPath);
      expect(calls[0].args).toEqual([
        join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
        "d1",
        "migrations",
        "apply",
        "callboard-disposable-demo-db",
        "--remote",
        "--config",
        join(root, "wrangler.demo.jsonc"),
      ]);
      expect(calls[0].options.shell).toBe(false);
      expect(calls.flatMap((call) => call.args)).not.toContain("deploy");
      expect(calls.flatMap((call) => call.args)).not.toContain("seed.mjs");
      expect(calls.flatMap((call) => call.args)).not.toContain("SELECT key FROM uploads ORDER BY key;");
      expect(calls.flatMap((call) => call.args)).not.toContain("DELETE FROM events");
    });
  });
});

describe("reset plan", () => {
  it("deletes every recorded R2 object before wiping D1 and reseeding", () => {
    const plan = resetPlan({
      databaseName: "callboard-disposable-demo-db",
      bucketName: "callboard-disposable-demo-files",
      uploadKeys: ["uploads/a.pdf", "headshots/b.png"],
    });
    expect(plan.map((step) => step.label)).toEqual([
      "apply migrations",
      "delete R2 object uploads/a.pdf",
      "delete R2 object headshots/b.png",
      "wipe mutable D1 state",
      "restore deterministic seed",
    ]);
    expect(plan[3].args.at(-1)).toContain("DELETE FROM events");
  });

  it("never places a production resource name in a valid plan", () => {
    const inspected = inspectDemoConfig({
      configPath: "/tmp/wrangler.demo.jsonc",
      source: validConfig,
      now: NOW,
    });
    expect(JSON.stringify(resetPlan({ ...inspected }))).not.toContain('"callboard-db"');
  });

  it("must not wipe D1 after any R2 deletion fails", () => {
    const plan = resetPlan({
      databaseName: "callboard-disposable-demo-db",
      bucketName: "callboard-disposable-demo-files",
      uploadKeys: ["uploads/a.pdf", "uploads/b.pdf"],
    }).slice(1);
    const calls = [];

    expect(() =>
      executePlan(plan, (step) => {
        calls.push(step.label);
        if (step.label === "delete R2 object uploads/b.pdf") throw new Error("R2 failed");
      }),
    ).toThrow("R2 failed");
    expect(calls).not.toContain("wipe mutable D1 state");
    expect(calls).not.toContain("restore deterministic seed");
  });
});

describe("demoExpired", () => {
  it("expires at the exact deadline", () => {
    expect(demoExpired("2026-08-08T12:00:00.000Z", NOW)).toBe(true);
  });

  it("fails closed for absent or malformed deadlines", () => {
    expect(demoExpired(undefined, NOW)).toBe(true);
    expect(demoExpired("later", NOW)).toBe(true);
  });

  it("does not expire before the deadline", () => {
    expect(demoExpired("2026-08-08T12:00:00.001Z", NOW)).toBe(false);
  });
});
