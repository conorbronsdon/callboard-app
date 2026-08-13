# Operating Callboard

This guide is for people deploying and operating their own Callboard instance.
It assumes that you control the Cloudflare Worker, D1 database, R2 bucket, and
deployment configuration. Follow the [Deployment guide](../README.md#deployment)
for provisioning and deployment commands; this page focuses on configuration,
security boundaries, and data recovery options.

## Secrets and environment variables

Store production secrets with `wrangler secret put`. Put non-secret deployment
variables in `wrangler.jsonc` or the environment-specific Wrangler config. For
local development, copy `.dev.vars.example` to the untracked `.dev.vars` file.
Never commit real credentials.

| Setting | Requirement | Purpose and behavior |
|---|---|---|
| `SESSION_SECRET` | Required production secret | HMAC key used to sign session cookies. A production request that needs it fails closed when it is missing. |
| `MAGIC_LINK_SECRET` | Required production secret | HMAC key used to sign magic-link sign-in tokens. A production request that needs it fails closed when it is missing. |
| `RATE_LIMIT_SECRET` | Required production secret | HMAC key used to hash rate-limit identifiers. D1 stores opaque digests instead of raw email addresses, person IDs, or IP addresses. |
| `RESEND_API_KEY` / `RESEND_FROM` | Optional mail configuration | A key enables delivery through Resend, and `RESEND_FROM` sets the sender used for both mail and calendar organizers. Without a key, Callboard uses the console mailer and writes messages to the Worker log instead of sending them. This is the supported default for judge and demo deployments. |
| `MAIL_DRIVER` | Optional mail control | Set this to `console` to force console-only mail even when a Resend key is present. Use it for test, development, and disposable demo environments that must never send real mail. |
| `ACCELEVENTS_API_KEY` / `ACCELEVENTS_EVENT_URL` | Optional integration configuration | Enables the Accelevents API push in addition to the speakers and sessions CSV pair. The CSV exports work without either value. The Integrations screen shows a clean not-configured state when the pair is absent. |
| `AIRTABLE_TOKEN` / `AIRTABLE_BASE` | Optional integration configuration | Enables the cron-driven, one-way Airtable mirror. Mirror work is queued and never blocks a user-facing write. Without both values, the mirror does not run and its surfaces show a not-configured state. |
| `APP_URL` | Deployment variable, not a secret | Absolute origin used when a link must be built without an incoming request, including scheduled mail. When a request is present, its origin takes precedence so preview links stay on the preview host. Without either a request origin or `APP_URL`, link creation fails. |
| `DEPLOYMENT_PROFILE` | Deployment variable, not a secret | The checked-in deployment is `production`. Only the value `demo` allows one-click seeded sign-in to be considered. |
| `DEMO_MODE` | Deployment variable, not a secret | A second, independent opt-in. `/demo` works only when this value is `1` or `true`, `DEPLOYMENT_PROFILE` is `demo`, and the demo deadline is valid. A stray `DEMO_MODE=1` in production does nothing on its own. |
| `DEMO_EXPIRES_AT` | Demo deployment variable, not a secret | ISO-8601 deadline for a disposable demo. A demo-profile Worker fails closed with 404 responses when this value is missing, malformed, or past. |
| `AI` | Optional native binding | Cloudflare Workers AI binding used for advisory review triage. It is the credential, so there is no API key to manage. If the binding is omitted, Callboard still runs and triage surfaces report that AI is unavailable in the deployment. |

The three required HMAC secrets should be independently generated values for
each deployment. Do not reuse production secrets in previews, development, or
the disposable demo. The public readiness probe checks that all three exist and
that D1 exposes the rate-limit table shape, without writing application data.

Console mail is a real operating mode, not an error state. Messages and magic
links appear in Worker logs, so treat access to those logs as sensitive. Set
`MAIL_DRIVER=console` explicitly wherever an inherited Resend key might
otherwise cause real delivery.

## Security posture

Callboard uses passwordless authentication. A public user must prove control of
their mailbox through a signed magic link before receiving a web session. A
provisional co-speaker record does not grant a session or authority over an
existing account.

Sessions use cookies signed by HMAC with `SESSION_SECRET`. Deployed cookies are
`Secure`, `HttpOnly`, and `SameSite=Lax`. `Lax` is deliberate: opening a magic
link from an email client is a cross-site navigation, and `Strict` would drop
the cookie during the sign-in flow that needs it.

Uploads pass through the Worker instead of using presigned R2 URLs. That keeps
ownership checks on both the write path and the read path, and it imposes a hard
25 MB limit on each upload. The file-library ZIP limit is a separate concern;
see [README Limitations](../README.md#limitations) for that boundary.

Public write paths use D1-backed fixed-window rate limits. These cover
magic-link issuance, inline sign-up, CFP writes and submission, and upload entry
points. Keys stored in D1 are HMAC digests of identifiers rather than raw email,
person, or IP values. An exhausted window returns `429` with `Retry-After`. If
the limiter, its secret, or its storage fails, the public write is refused
rather than allowed through.

The `/v1` API and the separate MCP Worker are not rate-limited today. This is a
known gap for operators who expose either endpoint broadly. Restrict and monitor
their reach, issue narrowly scoped API keys, and add edge controls appropriate
to the deployment.

Application rate limits are not a substitute for Cloudflare WAF rules,
Turnstile, or other edge abuse controls. The limits and their failure boundary
are summarized in [SECURITY.md](../SECURITY.md).

The judge/demo deployment is architecturally separate from production. It uses
a different Wrangler config, dedicated D1 and R2 resources, separate secrets,
its own expiry, and `MAIL_DRIVER=console`. It is a disposable deployment that
permits anonymous users to enter seeded accounts without letting them email
strangers. Demo access is not a switch on the production Worker. The complete
setup and teardown boundary is in the
[Deployment guide](../README.md#disposable-judge-demo).

## Backups and exports

Callboard has no built-in backup or restore tool. Installing the application
does not schedule backups, retain historical snapshots, copy R2 objects, or
provide an in-product restore workflow.

An operator can use standard Cloudflare tooling for the underlying data:

- Use `wrangler d1 export` to export the D1 database.

- Use normal R2 tooling and lifecycle rules to copy, retain, or expire uploaded
  files according to the deployment's requirements.

These are infrastructure-level operations. The operator is responsible for
scheduling them, storing copies outside the live resources, protecting those
copies, setting retention, and testing a recovery procedure. Callboard does not
manage or verify any of that work.

Callboard also ships data-portability features that provide practical exports:

- The Accelevents speakers and sessions CSV pair exports programme data and the
  speaker-to-session link through email addresses.

- The reviewer score CSV exports rubric results and reviewer comments.

- The `.ics` feeds export the published schedule or a selected itinerary.

- The `/v1` API provides scoped-key read access to events, sessions, speakers,
  and metadata for an operator-managed extraction process.

These exports are useful for moving organizer data into other systems. None is
a full database or file backup, and none can restore a Callboard deployment.

## Verification gates

CI covers type checking, repository guards, unit tests, a production build, a
migration-drift check, a guarded demo build, and Playwright. The repeated-release
CI job runs `npm run release:verify`, which also checks that database schema code
has not leaked into a client bundle. A separate CI-only job runs the lockfile
dependency audit with `npm audit --audit-level=high`; that audit is not part of
the local `npm run release:verify` script, so run it separately when evaluating
dependency advisories locally. See [README Verification](../README.md#verification)
for the commands and the limits of what each passing check proves.
