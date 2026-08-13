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
     * `scripts/` is included on purpose, and its extension is `.mjs`.
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
     * A glob that names both roots means adding a test outside `app/` cannot
     * silently do nothing again.
     */
    include: [
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "scripts/**/*.test.mjs",
    ],
  },
});
