/**
 * Vite config — Node land, so `process.env` is legitimate here (scripts/ and
 * the root config files are exempt from the no-process-env guard; see
 * scripts/guards.mjs).
 */
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const e2ePersistencePath = process.env.CALLBOARD_E2E_PERSIST_TO;

/*
 * The Cloudflare Vite plugin directly honors its documented
 * CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH variable. The guarded disposable-demo
 * build sets it to repository-root wrangler.demo.jsonc; normal builds leave it
 * unset and resolve wrangler.jsonc.
 *
 * This exists because `wrangler deploy --config <other>.jsonc` does NOT build:
 * an explicit --config bypasses the plugin's redirected-config handoff, leaving
 * Wrangler to bundle ./workers/app.ts from source, where the `~/*` tsconfig
 * alias and `virtual:react-router/server-build` do not exist. The demo has to be
 * BUILT with its config, not merely deployed with it.
 */
const guardedWranglerConfigPath = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // Share the runner's one-use state with Wrangler migration/seed commands.
      // Normal development keeps the plugin's default .wrangler/state store.
      persistState: e2ePersistencePath ? { path: e2ePersistencePath } : true,
      /*
       * Forward test/local overrides from the process that started the dev
       * server into the Worker's `vars`. Production deploys do not use Vite.
       *
       * `.dev.vars` is NOT a usable channel for this: it is gitignored, so it
       * cannot carry a committed test default, and its whole content is
       * replaced — not merged — when a `.dev.vars.<CLOUDFLARE_ENV>` exists.
       * The plugin's `config` customizer edits the resolved Wrangler config
       * directly, which is committed, needs no extra Wrangler environment (and
       * therefore no duplicated D1/R2 bindings), and leaves `wrangler.jsonc`
       * — the thing a deploy reads — untouched.
       *
       * Unset in normal development and in every deploy. `playwright.config.ts`
       * explicitly supplies console mail plus the disposable demo profile.
       */
      config: (config) => {
        const forwarded = {
          ...(process.env.MAIL_DRIVER ? { MAIL_DRIVER: process.env.MAIL_DRIVER } : {}),
          ...(process.env.DEPLOYMENT_PROFILE
            ? { DEPLOYMENT_PROFILE: process.env.DEPLOYMENT_PROFILE }
            : {}),
          ...(process.env.DEMO_MODE ? { DEMO_MODE: process.env.DEMO_MODE } : {}),
          ...(process.env.DEMO_EXPIRES_AT
            ? { DEMO_EXPIRES_AT: process.env.DEMO_EXPIRES_AT }
            : {}),
        };
        if (!guardedWranglerConfigPath && Object.keys(forwarded).length) {
          config.vars = { ...config.vars, ...forwarded };
        }
      },
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
