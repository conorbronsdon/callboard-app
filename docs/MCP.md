# Callboard MCP server

Callboard's remote Model Context Protocol server lets an MCP client inspect a
conference programme, search its CFP and speaker roster, and capture a new
abstract. It is a separate Cloudflare Worker using streamable HTTP. The Worker
has no Callboard bindings or database access; every operation goes through the
same public `/v1` API available to any other integration.

A live instance runs against the public demo conference:

```text
https://callboard-mcp.conor-afe.workers.dev/mcp
```

Mint a key for it at <https://demo.callboardhq.com/admin/api-keys> — the demo
offers one-click organizer sign-in, so this takes about a minute. `get_openapi`
needs no key at all, so a client can connect and discover the REST API before
you mint one.

`GET /` and `GET /health` return a small descriptor with the configured
Callboard origin and tool names. If you deploy your own instance, substitute the
URL Wrangler prints for the one above throughout this guide.

## Authentication

Send a Callboard API key on the MCP request as `x-access-token`. The MCP Worker
forwards that value as the same header on `/v1` calls. It also accepts
`Authorization: Bearer <key>` as a convenience. Credentials are never accepted
in the URL and never appear in tool output.

Keys are event-scoped and scopes do not cascade. Mint one at `/admin/api-keys`
on the configured Callboard deployment. When an event-scoped tool omits
`event_id`, the server calls `list_events` once per MCP request and reuses the
result. That inference needs `read:events`; callers without it can pass
`event_id` explicitly.

| Tool | Required scope |
|---|---|
| `list_events` | `read:events` |
| `get_schedule` | `read:sessions` |
| `list_submissions` | `read:sessions` |
| `get_submission` | `read:sessions` |
| `search_speakers` | `read:contacts` |
| `list_tracks` | `read:metadata` |
| `capture_abstract` | `write:sessions` |
| `get_openapi` | None |

## Tool reference

All results are compact JSON in a text content block. Collection tools retain
the public API's pagination block. Session descriptions are converted from HTML
to text and bounded; truncated values include their original length and a
visible recovery hint.

### `list_events`

Inputs: none. Returns the id, name, slug, and timezone of the single event the
key can reach, plus pagination.

### `get_schedule`

Inputs: `event_id?`, `track?` (id or exact name), `day?` (`YYYY-MM-DD`), and
`limit?` (default 50, maximum 100). Returns programme sessions
(`is_abstract:false`) in start-time order. Null start times are marked
`unscheduled`; a day filter excludes them. Day filtering happens after fetching
the first 100 upstream rows, so a `note` warns when the upstream result spans
more than that fetched page.

### `list_submissions`

Inputs: `event_id?`, `status?` (one or more of `draft`, `pending`,
`accept_queue`, `accepted`, `decline_queue`, `declined`, `withdrawn`), `text?`,
`track?`, `limit?` (default 25, maximum 100), and `page?`. Returns compact CFP
records (`is_abstract:true`) and pagination.

### `get_submission`

Inputs: `event_id?` and required `submission_id`. Returns a fuller compact
record, including CFP answers as `custom_fields`, participant names and contact
details, and a longer plain-text description. Review scores are not exposed by
the public API and are therefore not returned.

### `search_speakers`

Inputs: `event_id?`, `query?`, `limit?` (default 25, maximum 100), and `page?`.
Returns `{id,name,company,email,about}` rows plus pagination.

### `list_tracks`

Inputs: `event_id?`. Returns track ids, names, colours, order, and pagination.

### `capture_abstract`

This tool writes to the conference. Inputs: `event_id?`, required non-empty
`title`, `description?`, `track?` (a track id), `status?` (default `pending`),
and `custom_fields?` (string keys and values). It always creates
`is_abstract:true` and returns the new `id`, `friendly_id`, title, status, and
`admin_url` when present. The public create endpoint does not attach speakers,
so this tool does not accept participant fields.

### `get_openapi`

No key is required. Input: `section?`. With no section, returns a compact index
containing OpenAPI version, info, server URL, and each method/path with its
operation id and summary. Pass an operation id for that operation's full OpenAPI
fragment. Pass `full` only when the complete document is genuinely needed.

## Claude Code

Set the two shell variables, then add the remote server. CLI options must appear
before the server name:

```sh
export CALLBOARD_MCP_URL='https://callboard-mcp.conor-afe.workers.dev/mcp'
export CALLBOARD_KEY='cb_...'
claude mcp add --transport http --header "x-access-token: $CALLBOARD_KEY" callboard "$CALLBOARD_MCP_URL"
```

For project configuration, `.mcp.json` supports environment expansion so the
key need not be committed:

```json
{
  "mcpServers": {
    "callboard": {
      "type": "http",
      "url": "${CALLBOARD_MCP_URL}",
      "headers": {
        "x-access-token": "${CALLBOARD_KEY}"
      }
    }
  }
}
```

## claude.ai custom connector

An organization administrator can open **Settings → Connectors**, add a custom
connector, and enter the Worker `/mcp` URL. For API-key deployments, configure
a static request header named `x-access-token` with the scoped Callboard key.
Static request-header authentication is a beta hosted-Claude feature and the
credential is shared at the organization level; if that option is unavailable,
use Claude Code or configure the Worker's optional single-tenant fallback key.

## Raw streamable-HTTP exchange

These requests initialize the protocol, acknowledge initialization, list tools,
and call `get_schedule`. The stateless server does not require a session id.

```sh
export MCP_URL='https://callboard-mcp.conor-afe.workers.dev/mcp'
export CALLBOARD_KEY='cb_...'

curl -i -X POST "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-access-token: $CALLBOARD_KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'

curl -i -X POST "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-access-token: $CALLBOARD_KEY" \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -sS -X POST "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-access-token: $CALLBOARD_KEY" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

curl -sS -X POST "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-access-token: $CALLBOARD_KEY" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_schedule","arguments":{"event_id":"EVENT_ID","limit":20}}}'
```

## Self-hosting

Set `APP_ORIGIN` in `wrangler.mcp.jsonc` to the HTTPS origin of the Callboard
deployment, then deploy the separate Worker:

```sh
npx wrangler deploy --config wrangler.mcp.jsonc
```

Normally every MCP client supplies its own event-scoped key. A single-tenant
deployment may instead set a fallback secret; request headers still take
precedence:

```sh
npx wrangler secret put CALLBOARD_API_KEY --config wrangler.mcp.jsonc
```

The fallback is never included in `/`, `/health`, logs, errors, or tool output.

## Design notes and limits

- Isolation is deliberate: no D1, R2, Durable Object, AI, cron, or product
  module binding is present. The Worker can do only what `/v1` and its key allow.
- Abstracts and scheduled sessions are one API resource split by
  `is_abstract`; MCP names make the two common workflows explicit.
- Search records are projected and long text is bounded because tool schemas
  and results consume the model's context window directly.
- Review scores are not available on `/v1`.
- Schedule day filtering is client-side over the first upstream page and warns
  when that page cannot prove completeness.
- MCP writes are limited to creating abstracts. Deeper operations remain
  available to authorized integrations through the OpenAPI-described REST API.
