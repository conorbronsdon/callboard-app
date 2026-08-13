#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDemoBuildCheck } from "./demo-deploy-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(root, "wrangler.demo.jsonc");
const buildPath = resolve(root, "build");
const redirectPath = resolve(root, ".wrangler", "deploy", "config.json");
const now = Date.now();
const blockedEnvironment = new Set([
  "CALLBOARD_WRANGLER_CONFIG",
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
  "DEPLOYMENT_PROFILE",
  "DEMO_MODE",
  "DEMO_EXPIRES_AT",
  "MAIL_DRIVER",
  "APP_URL",
]);
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !blockedEnvironment.has(name)),
);

if (existsSync(configPath)) {
  console.error(
    "demo:build-check refuses to overwrite an existing wrangler.demo.jsonc; run it in a clean CI/release checkout.",
  );
  process.exitCode = 1;
} else {
  const source = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: "callboard-disposable-demo-offline-check",
    compatibility_date: "2026-08-08",
    main: "./workers/app.ts",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true },
    upload_source_maps: true,
    vars: {
      APP_URL: "https://callboard-disposable-demo-offline-check.example.test",
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
      MAIL_DRIVER: "console",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "callboard-disposable-demo-offline-check-db",
        database_id: "00000000-0000-4000-8000-000000000067",
        migrations_dir: "app/db/migrations",
      },
    ],
    r2_buckets: [
      {
        binding: "FILES",
        bucket_name: "callboard-disposable-demo-offline-check-files",
      },
    ],
    triggers: { crons: ["0 15 * * *", "*/30 * * * *"] },
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
    const plan = runDemoBuildCheck({
      argv: ["--config=wrangler.demo.jsonc"],
      root,
      now,
      // This verifier owns a minimal environment so a developer shell cannot
      // select a Wrangler environment or override the demo profile.
      environment: cleanEnvironment,
    });
    console.log(
      `demo:build-check: real guarded Vite build validated for ${plan.config.workerName}; upload attempts: 0`,
    );
  } catch (error) {
    console.error(`demo:build-check: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    rmSync(configPath, { force: true });
    rmSync(buildPath, { recursive: true, force: true });
    rmSync(redirectPath, { force: true });
  }
}
