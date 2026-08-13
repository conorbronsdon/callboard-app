# AGENTS.md — conventions for every coding agent in this repo

You own ONE workstream (WS) per session. Do not touch files outside your lane. Read
README.md for the stack, commands, and architecture, and DECISIONS.md for the product
judgment calls already settled — do not relitigate them.

## Ground rules
1. **Verification that can fail.** Write your lane's done-when down before you start: the specific, checkable conditions that make the lane complete. "Done" means every one of them passes and you show command output (test run, curl, screenshot). Mutate a check to red once before trusting its green. An edit is not evidence.
2. **Negative tests.** Every rule/filter/guard (conditional logic, conflict detection, routing, sanitization, CSV enums) gets a must-fire AND a must-not-fire test.
3. **Empty states count.** Every screen renders correctly with zero rows AND with seed rows; both are in your done-when.
4. **Schema is orchestrator-only.** NEVER edit `app/db/schema.ts` or `app/db/migrations/` — request changes from the orchestrator, who lands additive migrations on main; rebase onto them.
5. **Branches.** Work on `ws<N>-<slug>` in your own worktree. From your clone of this repository: `git worktree add ../callboard-ws<N> -b ws<N>-<slug>`. Push your branch; never touch main.
6. **Evidence from preview, not localhost.** `npm run preview` (wrangler versions upload) gives your lane a preview URL; acceptance screenshots come from it when the change is judge-visible.
7. **No new dependencies** without a one-line justification. Prefer platform APIs.
8. **Speed is a feature.** Public routes (CFP form, gallery, schedule, embeds): SSR, minimal client JS, no layout-shifting spinners. Admin routes may hydrate freely.
9. **Judgment calls get written down** — one line in `DECISIONS.md` (what + why) for any deliberate deviation from Sessionboard.

## Stack landmines (each has burned hours; do not rediscover them)
- **Env**: use the typed accessor around `context.cloudflare.env`. `process.env` is BANNED — it is undefined on deployed Workers. Grep your diff for it before pushing.
- **D1 has no interactive transactions** — Drizzle `.transaction()` throws. Use `db.batch()`; respect the ~100 bound-params per query cap.
- **Client-only UI** (drag-drop, DnD kit, anything touching `window`) goes inside `app/components/ClientOnly.tsx` — RR7 framework mode SSRs everything by default.
- **Cron never fires in `wrangler dev`.** Every job is an exported function reachable at authed `POST /admin/jobs/run?name=<job>`; cron claims are only accepted with output from that route.
- **Remote migrations are separate** — deploys run `migrate:remote`; if you see a 500 on a D1 route after deploy, that's the first suspect.
- **R2 uploads** go through the Worker proxy (25MB cap). No presigned URLs.
- **Cookies**: `Secure; HttpOnly; SameSite=Lax` — never Strict (email-initiated navigation).
- **Preview versions share PRODUCTION D1.** `npm run preview` gives you a preview URL whose DB is the live one — read-only verification there; never exercise write paths on a preview (WS2 finding).
- **Don't import runtime values from `app/db/schema.ts` into route components** — it drags drizzle's sqlite-core into the browser bundle (took one page from 41.3 kB to 10.8 kB when fixed). Import types only; re-export runtime constants from a pure module.
- **Each lane's dev server gets its own port.** An orphan server on 5173 once had a lane scoring its harness against another lane's app. Confirm whose server answers before trusting localhost results.

## Stack fixed points (don't relitigate)
Cloudflare Workers + React Router **v8** framework mode (DECISIONS #22); D1 + Drizzle; R2; Resend + ICS per the Saturday spike verdict; @dnd-kit; Vitest + Playwright golden-path smoke. Airtable is a one-way MIRROR (queue retries, never blocks writes). Secrets via `wrangler secret` / `.dev.vars`, never committed.

## Commands
- `npm run dev` — local dev (wrangler + vite)
- `npm run check` — typecheck + repo guards + vitest (must be green before handoff)
- `npm run migrate` / `npm run seed` — local D1 schema + demo data
- `npm run preview` — per-lane preview URL (`wrangler versions upload`)
- `npm run deploy` — orchestrator-only

Full command table and the rules that bite (no `process.env`, no D1 transactions,
`<ClientOnly>`, cron-vs-`/admin/jobs/run`) are in README.md.

## Repo layout (WS0 establishes; keep to it)
- `app/routes/` — route modules named `public.*`, `auth.*`, `admin.*`, `portal.*` (public = SSR-fast); registered in `app/routes.ts`, which has one block per group — append to yours
- `app/db/` — Drizzle schema + generated migrations + the D1 client
- `app/lib/` — pure logic (conflict detection, form-schema eval, scoring, CSV export) — unit-testable, no I/O. `*.server.ts` may touch bindings
- `app/components/` — shared UI (`Shell`, `ClientOnly`)
- `workers/app.ts` — Worker entry: fetch + `scheduled`. Jobs live in `app/lib/jobs/registry.server.ts`
- `scripts/` — plain Node tooling (seed, smoke, guards); the only place `process.env` is allowed
