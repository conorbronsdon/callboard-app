#!/usr/bin/env node
/**
 * Prepare the local D1 for the WS1b end-to-end walk: migrations, the WS0 demo
 * seed, then this lane's fixtures. Run it BEFORE the dev server so the tests
 * always start from a known database.
 *
 * Node script, not Worker code — `process.env` is legitimate here.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertDisposableStatePath } from "../../scripts/run-e2e.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shell = process.platform === "win32";
const persistencePath = assertDisposableStatePath(process.env.CALLBOARD_E2E_PERSIST_TO);

function run(label, command, args) {
  console.log(`[e2e:seed] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell });
  if (result.status !== 0) {
    console.error(`[e2e:seed] FAILED: ${label}`);
    process.exit(result.status ?? 1);
  }
}

run("migrations", "npm", [
  "run",
  "migrate",
  "--",
  "--persist-to",
  persistencePath,
]);
run("demo seed", "node", ["scripts/seed.mjs"]);
run("WS1b fixtures", "npx", [
  "wrangler",
  "d1",
  "execute",
  "callboard-db",
  "--local",
  "--persist-to",
  persistencePath,
  "--file=tests/e2e/fixtures.sql",
  "--yes",
]);

console.log("[e2e:seed] ready");
