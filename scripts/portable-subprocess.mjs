import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function wranglerInvocation(root, args) {
  return {
    command: process.execPath,
    args: [resolve(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args],
  };
}

/**
 * The React Router CLI ships `bin.cjs`, not `bin.js`. Same portability reason as
 * `wranglerInvocation`: the npm/npx shim is not directly spawnable with
 * `shell: false` on Windows, so always go through this process's own Node.
 */
export function reactRouterInvocation(root, args) {
  return {
    command: process.execPath,
    args: [resolve(root, "node_modules", "@react-router", "dev", "bin.cjs"), ...args],
  };
}

function spawnErrorDetail(error) {
  const code = typeof error?.code === "string" ? error.code : "SPAWN_ERROR";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message.replace(/[\r\n]+/g, " ")
      : "child process could not be started";
  return `${code}: ${message}`;
}

export function runCheckedSubprocess({
  command,
  args,
  cwd,
  capture = false,
  env,
  spawn = spawnSync,
}) {
  const result = spawn(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
    // Only ever an explicit whole environment; never logged, never partial.
    ...(env ? { env } : {}),
  });
  if (result.error) {
    throw new Error(`Child process spawn failed (${spawnErrorDetail(result.error)}).`);
  }
  if (result.status !== 0) {
    throw new Error(`Child process failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result.stdout ?? "";
}

export function runWrangler({ root, args, capture = false, spawn }) {
  const invocation = wranglerInvocation(root, args);
  return runCheckedSubprocess({ ...invocation, cwd: root, capture, spawn });
}
