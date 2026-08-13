# Security policy

## Supported versions

Callboard is currently pre-1.0. Security fixes are applied to the latest commit on
`main`; older commits and independently deployed forks are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when it
is available. Do not open a public issue containing an exploit, credentials,
personal data, or another user's submission content.

Include:

- the affected route, commit, or deployment;
- reproduction steps and impact;
- whether the report involves demo or production data; and
- any suggested mitigation.

If private reporting is unavailable, open a minimal public issue asking the
maintainer for a private contact channel, without vulnerability details.

## Demo deployment warning

One-click seeded authentication requires both
`DEPLOYMENT_PROFILE=demo` and `DEMO_MODE=1`. The checked-in/default
deployment is `production` with demo mode off; `/demo` fails closed even if
only the legacy flag is accidentally enabled.

A judge demo must be built from `wrangler.demo.example.jsonc` with dedicated
D1, R2, origin, and signing secrets. It intentionally exposes seeded admin and
speaker accounts, so do not enter real personal, confidential, or production
data there. The template does not provision reset, expiry, or edge throttling;
those remain mandatory before the URL is broadly shared.

## Provisional participant identities

A submitter may add a co-speaker by email, but that assertion is not mailbox
proof and grants no authority over an existing account. Participant details are
retained on the submission; only the authenticated submitter may use the CFP
flow to hydrate their own blank global profile. Brand-new participant rows may
receive initial defaults and must still complete a magic-link sign-in before
receiving a web session.

## Abuse-control boundary

Magic-link issuance, inline CFP signup, public CFP writes/submits, and upload
entry points use D1-backed fixed windows. Stored identifiers are keyed HMAC
digests rather than raw email, person, or IP values. Exhausted windows return
`429` with `Retry-After`; limiter/storage failures fail public writes closed.

These application limits do not replace Cloudflare WAF rules or Turnstile and
cannot stop distributed attacks that rotate IP addresses, email addresses, or
newly created identities. Configure edge controls before broad public launch.

## Scope

Reports about authentication or authorization bypass, cross-event data access,
stored content execution, secret exposure, destructive API behavior, and abuse
of email or file-storage resources are especially useful. Automated testing
must not target a public deployment without the maintainer's explicit approval.
