# Contributing to Callboard

Thanks for helping improve Callboard. Keep contributions focused on making the
event-production workflow reliable, understandable, and safe for nontechnical
operators.

## Before opening work

- Search existing issues and pull requests to avoid duplicate work.
- Open an issue before a large feature, data-model change, or new dependency so
  scope and migration impact can be agreed first.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md), never in a
  public issue.
- Read [AGENTS.md](AGENTS.md) for repository constraints and
  [DECISIONS.md](DECISIONS.md) for settled architecture choices.

## Local setup

Requires Node.js 22.22 or newer and npm. A Cloudflare account is not needed for
local development.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run migrate
npm run seed
npm run dev
```

Use a feature branch. Never commit `.dev.vars`, credentials, generated evidence
containing private data, Wrangler state, or Playwright artifacts.

## Engineering expectations

- Keep public pages server-rendered and avoid unnecessary client JavaScript.
- Read Worker configuration through the typed environment accessor; do not use
  `process.env` in `app/` or `workers/`.
- D1 does not support interactive Drizzle transactions. Use bounded
  `db.batch()` writes and respect D1 parameter limits.
- Send uploads through the authenticated Worker proxy.
- Pin GitHub Actions to full commit SHAs with a version comment.
- Explain any new runtime dependency in the pull request.
- Coordinate schema changes before implementation. Commit the generated,
  forward-compatible migration and prove `npm run migrations:check` is clean.

Every rule or guard needs a must-fire and must-not-fire test. User-facing work
should cover both an empty state and representative seeded data.

## Verification

Run the complete relevant gate before requesting review:

```sh
npm run check
npm run build
npm run migrations:check
npm run e2e
```

`npm run e2e` owns a fresh disposable local D1/R2 persistence directory and
must not target a remote deployment. For documentation-only changes, CI remains
the authoritative full-repository verification.

## Pull requests

A reviewable pull request should:

- describe the user-visible outcome and why the change is needed;
- keep unrelated refactors out of the diff;
- state security, migration, deployment, and compatibility impact;
- include tests and reproducible verification evidence;
- update README, API documentation, or the release ledger when claims change;
- disclose limitations and deferred work rather than presenting them as shipped.

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE). Be respectful and constructive in issues,
reviews, and discussions.
