# Callboard API

The Callboard API is for event, session, speaker, and shared-metadata integrations. It
follows Sessionboard-compatible conventions where reasonable, with a consistent response model.
Use the live [`/developers`](/developers) page for exhaustive endpoint details.

## Base URL and authentication

The API is versioned under `/v1` on your Callboard deployment origin. Set these values before running the examples:

```sh
export CALLBOARD_ORIGIN='https://callboard.example'
export CALLBOARD_KEY='replace-with-your-api-key'
export EVENT_ID='replace-with-your-event-id'
export SESSION_ID='replace-with-a-test-session-id'
```

Mint an API key at `/admin/api-keys`. Send it in the `x-access-token` header:

```sh
curl -sS "$CALLBOARD_ORIGIN/v1/events" \
  -H "x-access-token: $CALLBOARD_KEY"
```

`Authorization: Bearer <key>` is also accepted. Each key belongs to exactly one
event and carries an explicit set of scopes. Every write resource is event-scoped
under `/v1/event/{eventId}/...`.

### Scopes

| Scope | Grants |
|---|---|
| `read:events` | Read the event associated with the key |
| `read:sessions` | Search and read sessions and abstracts |
| `write:sessions` | Create, update, delete, restore, and bulk-write sessions and abstracts |
| `read:contacts` | Search and read speakers |
| `read:metadata` | List and search tracks, rooms, tags, formats, and levels |
| `write:metadata` | Create tracks, rooms, tags, formats, and levels |

Scopes do not cascade. `read:sessions` grants nothing outside session reads, and no
read scope implies its write counterpart. A key used outside its event or scopes receives `403 Forbidden`.

The mint form offers three choices:

- **Read only** grants all four `read:*` scopes and no write scopes.
- **Read + write** grants all six scopes.
- **Custom** lets you select any combination of the six scopes.

## Responses, errors, and pagination

Every collection response has one envelope:

```json
{
  "results": [],
  "pagination": {
    "currentPage": 1,
    "pageSize": 25,
    "totalPages": 1,
    "totalResults": 0
  }
}
```

Put `page` and `pageSize` in the query string for a GET collection and in the JSON
body for a POST search. This searches both resource types and returns page two:

```sh
curl -sS -X POST \
  "$CALLBOARD_ORIGIN/v1/event/$EVENT_ID/sessions/search" \
  -H "x-access-token: $CALLBOARD_KEY" \
  -H 'content-type: application/json' \
  -d '{"filters":{"status":["accepted"]},"sort":{"order":"startsAt","sort":"asc"},"page":2,"pageSize":10}'
```

Session search sorting accepts `createdAt`, `updatedAt`, `startsAt`, and `title`. Unassigned
metadata such as `track`, `room`, `format`, and `level` is `null`, never `{}`.
Resource reads are not cached, so a read reflects the most recent completed write.

Errors use one shape:

```json
{
  "error": "ForbiddenError",
  "message": "This API key is missing the `read:sessions` scope. Scopes do not cascade."
}
```

A missing, invalid, or revoked key returns `401`. A valid key for the wrong event or
without the required scope returns `403`. An unknown `/v1/*` path returns `404` before
authentication. A wrong verb on a real path returns `405` with an `Allow` header.

Keys prefixed with `__` inside `answers` or `custom_fields`, such as `__capture`, belong
to Callboard. They are stripped from object or array writes while stored keys are preserved.

## Optimistic concurrency

Optimistic concurrency is opt-in. Include the exact `updated_at` from your last read in
a `PUT`. A newer completed write then causes `409 Conflict` instead of an overwrite.

The following example assumes `UPDATED_AT` is from an earlier read of a test
session. The first request represents another client's intervening write. The
second request then receives `409` because its timestamp is stale.

```sh
export UPDATED_AT='2026-08-06T12:00:00.000Z'

curl -sS -X PUT \
  "$CALLBOARD_ORIGIN/v1/event/$EVENT_ID/sessions/$SESSION_ID" \
  -H "x-access-token: $CALLBOARD_KEY" \
  -H 'content-type: application/json' \
  -d '{"title":"An intervening edit"}' > /dev/null

curl -i -X PUT \
  "$CALLBOARD_ORIGIN/v1/event/$EVENT_ID/sessions/$SESSION_ID" \
  -H "x-access-token: $CALLBOARD_KEY" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"My stale edit\",\"updated_at\":\"$UPDATED_AT\"}"
# HTTP 409
# {"error":"ConflictError","message":"Stale `updated_at`. The session was last modified at ..."}
```

Omit `updated_at` and the write is applied unconditionally. That is the
deliberate default for integrations that do not need lost-update protection.

## Publishing and the informed-speaker gate

The [programme publishing guide](guides/publish-your-programme.md) explains what
it means for a speaker to be informed. The same gate applies to API updates.
Changing a private session to `is_public: true` returns `409` unless its speaker
has been informed.

```sh
curl -i -X PUT \
  "$CALLBOARD_ORIGIN/v1/event/$EVENT_ID/sessions/$SESSION_ID" \
  -H "x-access-token: $CALLBOARD_KEY" \
  -H 'content-type: application/json' \
  -d '{"is_public":true}'
# HTTP 409
# {"error":"ConflictError","message":"The speaker hasn't been told about this session yet. Send their decision letter, or pass `publish_override: true`."}
```

If you have independently confirmed that publication is appropriate, repeat the
update with the informed-gate override:

```sh
curl -i -X PUT \
  "$CALLBOARD_ORIGIN/v1/event/$EVENT_ID/sessions/$SESSION_ID" \
  -H "x-access-token: $CALLBOARD_KEY" \
  -H 'content-type: application/json' \
  -d '{"is_public":true,"publish_override":true}'
# HTTP 200
```

Camel-case `publishOverride` is also accepted. The override and `is_public`
cannot be set on create; create the record first, then update it. Unpublishing
with `is_public: false` is never gated.

## Resource model and bulk writes

Abstracts and scheduled sessions are one resource. The immutable `is_abstract`
field identifies which kind was created. An abstract is never changed into a
session; it is composed into one, and `composition_status` identifies a
standalone record, the abstract source, or the programme-session target.

The sessions bulk operation accepts up to 100 create, update, or delete
operations in one request. It uses partial success: one bad row does not fail
the other rows, and the response reports the outcome of every operation along
with succeeded and failed totals.

There is no per-key or per-IP rate limiting on `/v1` today. Integrators should
be considerate with request volume rather than assuming standard API throttles
are in place. A simple per-key limiter is a possible future addition, not a
committed feature or timeline.

## Webhooks

For push-based integration instead of polling, Callboard can send signed
outbound events (session and contact lifecycle, decisions) to endpoints you
register from **Admin → Integrations**. See [Webhooks](WEBHOOKS.md) for the
event catalogue, the HMAC signature format, and delivery guarantees.

## Complete endpoint reference

Every endpoint, with a ready-to-run curl command and a response example, is at `/developers` on any deployment — this page explains the concepts once; that page is the exhaustive reference and is generated from the same code that produces `/v1/openapi.json`, so it can't drift from what's actually deployed.
