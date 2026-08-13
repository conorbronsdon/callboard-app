/**
 * Test stand-in for the `cloudflare:workers` module.
 *
 * `vitest.config.ts` aliases `cloudflare:workers` to THIS file, so
 * `app/lib/env.server.ts` — and therefore every `getDb()` / `appEnv()` caller —
 * reads bindings from here under Vitest while production code is untouched.
 *
 * The export is a single mutable object on purpose: `installTestDb()` writes
 * `DB` into it, and because the alias resolves to this exact path, helpers that
 * import it relatively get the same module instance the app code sees.
 */
export const env: Record<string, unknown> = {};

/** Direct unit-test calls have no Worker request lifetime to extend. */
export function waitUntil(_promise: Promise<unknown>): void {
  throw new Error("waitUntil called outside a Worker request context");
}

/** Wipe every binding between tests so one test cannot leak into the next. */
export function resetEnv(): void {
  for (const key of Object.keys(env)) delete env[key];
}
