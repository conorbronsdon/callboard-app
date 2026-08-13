# Outbound webhooks

Callboard emits eight outbound event types. Delivery is optional and never changes the outcome of the write that caused it.

## Event catalogue

- `session.created` — after a session or abstract row is durably created through the v1 API, the admin create/capture controls, or the public draft creator.
- `session.updated` — after the v1 API updates an existing session without publishing it, or the primary admin session-content editor updates a session and its linked counterpart.
- `session.deleted` — after the v1 API successfully soft-deletes a live session.
- `session.published` — after an unpublished session becomes public through the v1 API or the Agenda `set-published` / gate-filtered `publish-all` controls. An unpublish and a gate-held session do not emit it.
- `contact.created` — once per contact row created by a successful CSV import commit.
- `contact.updated` — after the contact detail screen writes travel and logistics notes to the organization-level `people` row.
- `contact.merged` — after the contact merge batch commits; `resourceId` is the survivor and `data.mergedAwayId` identifies the tombstoned row.
- `decision.committed` — once per abstract that actually transitions to `accepted` or `declined`, from either the direct status control or a queue commit. Re-committing an already-decided row emits nothing.

## Envelope

Built-in endpoints receive this JSON object. The JSON string used as the request body is also the exact byte sequence Callboard signs.

```json
{
  "data": {},
  "metadata": {
    "event": "session.published",
    "resourceId": "session-id",
    "eventId": "fresh-id-for-this-emission",
    "occurredAt": "2026-08-12T20:00:00.000Z",
    "version": 1
  }
}
```

`metadata.eventId` is a new random identifier for every emission. Receivers can use it as a deduplication key; it is not the affected row's `resourceId`.

## Built-in driver

With Svix unconfigured, Callboard reads active endpoints from the organization-level `webhooks` table. Each endpoint has its own secret. Callboard sends:

```text
x-callboard-signature: sha256=<lowercase HMAC-SHA256 hex>
```

The HMAC covers the raw request body bytes, not parsed and reserialized JSON. A receiver should retain the raw body until verification is complete. For example, in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyCallboard(rawBody, header, secret) {
  const supplied = Buffer.from(header.replace(/^sha256=/, ""), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
```

The built-in driver is deliberately small. It retries once immediately after a network failure or a 5xx response. It does not retry 4xx responses because those are permanent receiver errors. It has no queue, Durable Object queue, or replay scheduler, so **at-least-once delivery is not guaranteed**. `webhook_deliveries` is the source of truth for what Callboard actually attempted and the final outcome of those attempts.

A `success` row here means the receiving endpoint itself returned a 2xx response — an actual delivery, not merely an attempt — which is why the Integrations UI labels it "Delivered." That word is earned here the same way comms mail status earns "Accepted by mail service" instead of "delivered": say only what the system actually observed. Svix-mode rows never carry that label; see below.

In an HTTP request, Callboard registers the complete delivery/logging promise with Cloudflare's importable `waitUntil` API, which is the platform's `ExecutionContext.waitUntil` lifetime extension without passing context through every route. A direct route action or library call outside a Worker request awaits the same promise instead. No delivery uses an untracked floating promise.

Endpoint secrets are stored in plaintext because future HMACs require the original key. The create response shows a new secret once. Every later list/read projection omits the `secret` column entirely.

## Svix driver

[Svix](https://link.svix.com/cot) is a managed webhook-delivery service: it takes over retries, endpoint management, and delivery observability so you do not run that infrastructure yourself. Callboard does not require it — the built-in driver above signs and delivers to any endpoint you choose with no third-party service at all. The judged demo deployment is set up with Svix as a working example of the managed driver; self-hosters can use Svix, any equivalent service in front of the built-in driver, or nothing beyond the built-in driver.

Set both `SVIX_TOKEN` and `SVIX_APP_ID` to select Svix. Setting only one keeps the built-in driver active. In Svix mode Callboard does not read local webhook endpoints and does no signing or fan-out. It makes one authenticated handoff to:

```text
POST https://api.svix.com/api/v1/app/{app_id}/msg
Authorization: Bearer <SVIX_TOKEN>
Idempotency-Key: <metadata.eventId>
```

The message body uses Svix's verified `eventType`, `payload`, and `eventId` fields. `payload` contains the complete Callboard envelope. Callboard logs one `webhook_deliveries` row with `driver = "svix"` and `webhookId = NULL`; its status says whether Svix accepted the handoff, not whether Svix later reached a downstream endpoint.

Svix provides enterprise delivery semantics per its own platform. Callboard does not own or guarantee those downstream semantics.

## Current write-path coverage

All session creation paths named in the webhooks lane are wired: v1 `createSession`, both admin Submissions creates, and public draft creation. Contact creation is per imported row. `contact.updated` currently covers the only contact-detail intent that directly updates `people` (`save-travel`). `set-tags` updates the `contact_tags` join table and does not emit `contact.updated`; the CRM directory currently has no full-profile edit intent.
