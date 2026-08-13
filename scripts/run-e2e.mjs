#!/usr/bin/env node
/**
 * Run the mutation-heavy Playwright suite against a fresh, disposable
 * Cloudflare persistence root. Wrangler CLI setup and the Vite plugin receive
 * the same absolute path, so D1 and R2 state cannot leak between runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_STATE_PREFIX = join(tmpdir(), "callboard-e2e-");

export function assertDisposableStatePath(value) {
  if (!value) throw new Error("E2E persistence path is required.");

  const absolute = resolve(value);
  const relativeToTemp = relative(resolve(tmpdir()), absolute);
  const insideTemp =
    relativeToTemp !== "" &&
    relativeToTemp !== ".." &&
    !relativeToTemp.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(relativeToTemp);

  if (!insideTemp || !basename(absolute).startsWith("callboard-e2e-")) {
    throw new Error(
      `Refusing non-disposable E2E persistence path: ${absolute}. ` +
        `Expected a callboard-e2e-* directory inside ${resolve(tmpdir())}.`,
    );
  }

  return absolute;
}

function run(label, command, args, env) {
  console.log(`[e2e] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 1}`;
    throw new Error(`${label} failed (${reason})`);
  }
}

export function withDisposableState(task) {
  const persistencePath = assertDisposableStatePath(mkdtempSync(E2E_STATE_PREFIX));
  console.log(`[e2e] disposable persistence: ${persistencePath}`);
  try {
    return task(persistencePath);
  } finally {
    rmSync(persistencePath, { recursive: true, force: true, maxRetries: 3 });
    console.log(`[e2e] removed disposable persistence: ${persistencePath}`);
  }
}

export function main() {
  if (process.env.CALLBOARD_E2E_URL) {
    throw new Error(
      "npm run e2e owns its local server and disposable persistence. " +
        "Unset CALLBOARD_E2E_URL; direct Playwright runs against another server are not release evidence.",
    );
  }

  withDisposableState((persistencePath) => {
    const env = {
      ...process.env,
      CALLBOARD_E2E_PERSIST_TO: persistencePath,
      MAIL_DRIVER: "console",
    };

    run("prepare isolated D1", "node", ["tests/e2e/seed.mjs"], env);
    run("Playwright", "npx", ["playwright", "test"], env);
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
