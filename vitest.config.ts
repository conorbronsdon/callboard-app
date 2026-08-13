import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Deliberately does NOT load vite.config.ts — the Cloudflare plugin would try to
 * boot workerd for a unit-test run.
 *
 * `cloudflare:workers` is aliased to a plain module (app/test/workers-env.ts) so
 * server code that reads bindings — `getDb()`, `appEnv()` — runs unmodified in
 * Node against an in-memory SQLite D1 stand-in (app/test/d1.ts). Anything that
 * genuinely needs workerd is covered by the Playwright smoke instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL("./app/test/workers-env.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    /*
     * `scripts/` and `workers/` are included on purpose, alongside `app/`.
     *
     * The previous pattern was `app/**` only, which silently excluded
     * `scripts/demo-lifecycle.test.mjs` and `scripts/run-e2e.test.mjs` — both
     * written for vitest, both passing, neither ever executed by `npm run
     * check`, `npm run release:verify`, CI, or the exact-SHA repeat gate. They
     * cover the two most destructive scripts in the repository: the guarded
     * demo D1/R2 reset, and `assertDisposableStatePath`, which is the check
     * standing between `rmSync(recursive, force)` and a directory that is not a
     * disposable E2E state root. Coverage that cannot fail the build is not
     * coverage, and a suite that silently drops whole files reports a test
     * count that overstates what was verified.
     *
     * `workers/` is the actual Worker entrypoint code (workers/app.ts,
     * workers/mcp.ts) and had ZERO test files before the blindspot audit —
     * cron/registry glue and the standalone MCP Worker's config validation and
     * isolate-reuse invariant were entirely unexercised. `workers/app.ts`
     * itself still can't be imported directly here (it calls
     * `createRequestHandler` against `virtual:react-router/server-build` at
     * module load, a Vite-only virtual module this plain-Node vitest config
     * deliberately does not resolve — see the file header above); its testable
     * logic is covered indirectly through app/lib/jobs/registry.server.test.ts
     * instead. `workers/mcp.ts` has no such import and is tested directly.
     *
     * A glob that names every root means adding a test outside `app/` cannot
     * silently do nothing again.
     */
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "scripts/**/*.test.mjs",
      "workers/**/*.test.ts",
    ],
  },
});
