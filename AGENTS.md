# AGENTS.md — conventions for every coding agent in this repo

Read README.md for the stack, commands, and architecture, and DECISIONS.md for the
product judgment calls already settled — do not relitigate them.

## Ground rules
1. **Verification that can fail.** Write your lane's done-when down before you start: the specific, checkable conditions that make the lane complete. "Done" means every one of them passes and you show command output (test run, curl, screenshot). Mutate a check to red once before trusting its green. An edit is not evidence.
2. **Negative tests.** Every rule/filter/guard (conditional logic, conflict detection, routing, sanitization, CSV enums) gets a must-fire AND a must-not-fire test.
3. **Empty states count.** Every screen renders correctly with zero rows AND with seed rows; both are in your done-when.
4. **Schema changes are coordinated.** Open an issue before editing `app/db/schema.ts` or `app/db/migrations/`; migrations must be additive and committed with the change.
5. **Branches.** Work on a feature branch and open a pull request. Do not commit to `main` directly.
6. **Evidence from preview, not localhost.** `npm run preview` (wrangler versions upload) gives you a preview URL; acceptance screenshots come from it when the change is user-visible.
7. **No new dependencies** without a one-line justification. Prefer platform APIs.
8. **Speed is a feature.** Public routes (CFP form, gallery, schedule, embeds): SSR, minimal client JS, no layout-shifting spinners. Admin routes may hydrate freely.
9. **Judgment calls get written down** — one line in `DECISIONS.md` (what + why) for any deliberate deviation from Sessionboard.
10. **Docs move with the code that invalidates them.** A PR that changes behavior a `DECISIONS.md` entry describes amends that entry in the same PR — a correction note is fine, a silent rewrite is not (see DECISIONS.md #10's own audit correction for the pattern). A PR that adds a new gate, scope, or override to the v1 API updates `docs/API.md` and the `llms.txt`/`public.llms.ts` agent-facing surface in the same PR — `app/test/llms-api-surface.test.ts` catches a doc that goes stale against what already shipped, never one that was simply never written.

## Stack landmines (each has burned hours; do not rediscover them)
- **Env**: use the typed `appEnv()` accessor in `app/lib/env.server.ts` (wraps the `cloudflare:workers` module's `env` export — NOT `context.cloudflare.env`, which the Cloudflare Vite plugin does not populate on the router context; see that file's header for why). `process.env` is BANNED in `app/` and `workers/` — it is undefined on deployed Workers. Grep your diff for it before pushing. (Node scripts under `scripts/`, `playwright.config.ts`, and test/config files legitimately use real `process.env` — the ban is scoped to application code.)
- **D1 has no interactive transactions** — Drizzle `.transaction()` throws. Use `db.batch()`; respect the ~100 bound-params per query cap.
- **Client-only UI** (drag-drop, DnD kit, anything touching `window`) goes inside `app/components/ClientOnly.tsx` — React Router v8 framework mode SSRs everything by default.
- **Cron never fires in `wrangler dev`.** Every job is an exported function reachable at authed `POST /admin/jobs/run?name=<job>`; cron claims are only accepted with output from that route.
- **Remote migrations are separate** — deploys run `migrate:remote`; if you see a 500 on a D1 route after deploy, that's the first suspect.
- **R2 uploads** go through the Worker proxy (25MB cap). No presigned URLs.
- **Cookies**: `Secure; HttpOnly; SameSite=Lax` — never Strict (email-initiated navigation).
- **Preview versions share PRODUCTION D1.** `npm run preview` gives you a preview URL whose DB is the live one — read-only verification there; never exercise write paths on a preview.
- **Don't import runtime values from `app/db/schema.ts` into route components** — it drags drizzle's sqlite-core into the browser bundle (took one page from 41.3 kB to 10.8 kB when fixed). Import types only; re-export runtime constants from a pure module.
- **If you run more than one dev server, give each its own port.** An orphan on 5173 will silently answer for a different checkout. Confirm whose server answers before trusting localhost results.

## Stack fixed points (don't relitigate)
Cloudflare Workers + React Router **v8** framework mode (DECISIONS #22); D1 + Drizzle; R2; Resend + ICS (verified end-to-end; see DECISIONS.md #28); @dnd-kit; Vitest + Playwright golden-path smoke. Airtable is a one-way MIRROR (queue retries, never blocks writes). Secrets via `wrangler secret` / `.dev.vars`, never committed.

## Commands
- `npm run dev` — local dev (wrangler + vite)
- `npm run check` — typecheck + repo guards + vitest (must be green before handoff)
- `npm run migrate` / `npm run seed` — local D1 schema + demo data
- `npm run preview` — per-lane preview URL (`wrangler versions upload`)
- `npm run deploy` — maintainers only

Full command table and the rules that bite (no `process.env`, no D1 transactions,
`<ClientOnly>`, cron-vs-`/admin/jobs/run`) are in README.md.

## Repo layout
- `app/routes/` — route modules named `public.*`, `auth.*`, `admin.*`, `portal.*` (public = SSR-fast); registered in `app/routes.ts`, which has one block per group — append to yours
- `app/db/` — Drizzle schema + generated migrations + the D1 client
- `app/lib/` — pure logic (conflict detection, form-schema eval, scoring, CSV export) — unit-testable, no I/O. `*.server.ts` may touch bindings
- `app/components/` — shared UI (`Shell`, `ClientOnly`)
- `workers/app.ts` — Worker entry: fetch + `scheduled`. Jobs live in `app/lib/jobs/registry.server.ts`
- `scripts/` — plain Node tooling (seed, smoke, guards); `process.env` is legitimate here (and in test/config files like `playwright.config.ts`) — the ban is on `app/` and `workers/` application code, not the whole repo
