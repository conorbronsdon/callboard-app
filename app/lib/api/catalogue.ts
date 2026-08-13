/**
 * The endpoint catalogue — ONE list that feeds both `/v1/openapi.json` and the
 * `/developers` page.
 *
 * Two hand-maintained copies of an endpoint list is how docs go stale: the page
 * says a route exists, the spec disagrees, and an integrator trusts whichever
 * one they opened. `api-catalogue.test.ts` closes the third gap by asserting
 * every entry here has a matching line in `app/routes.ts`.
 *
 * PURE — no bindings, no DB. `origin` is passed in.
 */
import type { ApiScope } from "./scopes";

export interface ApiOperation {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** OpenAPI path template, e.g. `/v1/event/{eventId}/sessions/{sessionId}`. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  /** Required scope, or null for "any valid key". Scopes never cascade. */
  scope: ApiScope | null;
  requestExample?: unknown;
  responseExample?: unknown;
}

const SESSION_EXAMPLE = {
  id: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
  event_id: "0000000ev-0000-4000-8000-000000000001",
  friendly_id: "ABS-3",
  title: "Shipping agents that survive contact with users",
  status: "accepted",
  is_abstract: true,
  starts_at: null,
  ends_at: null,
  capacity: null,
  is_public: false,
  composition_status: {
    role: "standalone",
    is_linked: false,
    is_read_only: false,
    source_count: 0,
    target: null,
  },
  track: { id: "…", event_id: "…", name: "Agents", order: 0, color: "#329af0" },
  room: null,
  participants: [],
  custom_fields: [{ key: "takeaways", value: "Three things you can apply Monday." }],
  created_at: "2026-07-25T12:00:00.000Z",
  updated_at: "2026-08-06T12:00:00.000Z",
  deleted_at: null,
  admin_url: "https://callboard.example/admin/submissions/497f6eca-…",
};

const PAGINATION_EXAMPLE = {
  currentPage: 1,
  pageSize: 25,
  totalPages: 1,
  totalResults: 8,
};

export const API_OPERATIONS: ApiOperation[] = [
  {
    method: "GET",
    path: "/v1/events",
    operationId: "listEvents",
    summary: "List events",
    description:
      "Every event the presented key can reach. Keys are minted per event, so this returns exactly one event — the entry point that tells an integration which `eventId` to use everywhere else.",
    scope: "read:events",
    responseExample: {
      results: [
        {
          id: "0000000ev-0000-4000-8000-000000000001",
          name: "Frontier AI Summit 2026",
          slug: "frontier-ai-summit-2026",
          timezone: "America/Los_Angeles",
        },
      ],
      pagination: { ...PAGINATION_EXAMPLE, totalResults: 1 },
    },
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/sessions/search",
    operationId: "searchSessions",
    summary: "Search sessions and abstracts",
    description:
      "The workhorse. Abstracts and programme sessions are one resource discriminated by `is_abstract`, so this endpoint serves both 'list the CFP' and 'list the agenda'. `POST /v1/event/{eventId}/sessions` is an alias for wire compatibility with Sessionboard's POST-on-collection search.",
    scope: "read:sessions",
    requestExample: {
      filters: { status: ["accepted", "pending"], is_abstract: true, text: "agents" },
      sort: { order: "updatedAt", sort: "desc" },
      page: 1,
      pageSize: 25,
    },
    responseExample: { results: [SESSION_EXAMPLE], pagination: PAGINATION_EXAMPLE },
  },
  {
    method: "GET",
    path: "/v1/event/{eventId}/sessions/{sessionId}",
    operationId: "getSession",
    summary: "Get one session",
    description:
      "Full record: participants, metadata, composition status, and CFP answers as `custom_fields`.",
    scope: "read:sessions",
    responseExample: SESSION_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/sessions/create",
    operationId: "createSession",
    summary: "Create a session or abstract",
    description:
      "`title` is the only required field. `is_abstract: true` creates a CFP submission and is immutable afterwards — an abstract never becomes a session, it gets composed into one. `is_public` is update-only.",
    scope: "write:sessions",
    requestExample: {
      title: "Evals that predict production failures",
      is_abstract: true,
      status: "pending",
      description: "<p>HTML allowed.</p>",
    },
    responseExample: SESSION_EXAMPLE,
  },
  {
    method: "PUT",
    path: "/v1/event/{eventId}/sessions/{sessionId}",
    operationId: "updateSession",
    summary: "Update a session",
    description:
      "Partial update. Send the `updated_at` you last read to get optimistic concurrency: a `409` means somebody else wrote first. Omit it to force the write. Flipping `is_public` true requires a scheduled time and the speaker's decision letter to have been sent, or `publish_override: true`. Publication is also refused when the final placement would create a blocking room or speaker conflict, unless `publish_force: true` is sent.",
    scope: "write:sessions",
    requestExample: { status: "accepted", updated_at: "2026-08-06T12:00:00.000Z" },
    responseExample: SESSION_EXAMPLE,
  },
  {
    method: "DELETE",
    path: "/v1/event/{eventId}/sessions/{sessionId}",
    operationId: "deleteSession",
    summary: "Soft-delete a session",
    description:
      "The row stays and `deleted_at` is set. Deleted rows drop out of search unless you pass `filters.include_deleted`.",
    scope: "write:sessions",
    responseExample: { id: "497f6eca-…", deleted_at: "2026-08-08T18:04:00.000Z" },
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/sessions/{sessionId}/restore",
    operationId: "restoreSession",
    summary: "Restore a soft-deleted session",
    description: "Clears `deleted_at`. 404s if the session was never deleted.",
    scope: "write:sessions",
    responseExample: SESSION_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/sessions/bulk",
    operationId: "bulkSessions",
    summary: "Bulk create / update / delete",
    description:
      "Up to 100 operations, applied in order with PARTIAL SUCCESS: each item reports its own status, and one bad row never sinks the batch. The response carries a `batch_id` and a `stats` block.",
    scope: "write:sessions",
    requestExample: {
      operations: [
        { action: "create", data: { title: "Lightning: tool-calling traps" } },
        { action: "update", id: "497f6eca-…", data: { status: "accepted" } },
        { action: "delete", id: "8f14e45f-…" },
      ],
    },
    responseExample: {
      batch_id: "3f1c…",
      results: [
        { index: 0, action: "create", status: "success", id: "…" },
        {
          index: 1,
          action: "update",
          status: "error",
          error: { code: "not_found", message: "Session not found." },
        },
      ],
      stats: { total: 2, succeeded: 1, failed: 1 },
    },
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/speakers/search",
    operationId: "searchSpeakers",
    summary: "Search speakers",
    description:
      "Speakers are a projection over contacts — anyone who is a participant on a live session of this event. `POST /v1/event/{eventId}/speakers` is the compatibility alias.",
    scope: "read:contacts",
    requestExample: { filters: { text: "okafor" }, page: 1, pageSize: 25 },
    responseExample: {
      results: [
        {
          id: "…",
          email: "rina@example.com",
          full_name: "Rina Okafor",
          company_name: "Company 1",
          about: "…",
          photo_url: null,
        },
      ],
      pagination: PAGINATION_EXAMPLE,
    },
  },
  {
    method: "GET",
    path: "/v1/event/{eventId}/speakers/{contactId}",
    operationId: "getSpeaker",
    summary: "Get one speaker",
    description:
      "The contact record plus `session_ids` — the sessions this person is on, which is what every speaker-portal view needs.",
    scope: "read:contacts",
  },
  {
    method: "GET",
    path: "/v1/event/{eventId}/{family}",
    operationId: "listMetadata",
    summary: "List a metadata family",
    description:
      "`family` is one of `tracks`, `rooms`, `tags`, `formats`, `levels`. One generic handler serves all five; `POST` on the same path searches with `filters.text`.",
    scope: "read:metadata",
    responseExample: {
      results: [
        {
          id: "…",
          event_id: "…",
          name: "Agents",
          order: 0,
          color: "#329af0",
          created_at: "…",
          updated_at: "…",
        },
      ],
      pagination: { ...PAGINATION_EXAMPLE, totalResults: 3 },
    },
  },
  {
    method: "POST",
    path: "/v1/event/{eventId}/{family}/create",
    operationId: "createMetadata",
    summary: "Create a metadata row",
    description:
      "`name` is required. `color` (tracks), `capacity` (rooms) and `default_minutes` (formats) are accepted only on the family that has the column.",
    scope: "write:metadata",
    requestExample: { name: "Workshop Room 3", capacity: 60 },
  },
];

/** The five families the generic handler serves. Mirrors `METADATA_FAMILIES`. */
export const METADATA_FAMILY_PATHS = ["tracks", "rooms", "tags", "formats", "levels"] as const;

/** A copy-pasteable curl line for the docs page. */
export function curlFor(operation: ApiOperation, origin: string, eventId: string): string {
  const path = operation.path
    .replace("{eventId}", eventId)
    .replace("{sessionId}", "SESSION_ID")
    .replace("{contactId}", "CONTACT_ID")
    .replace("{family}", "tracks");

  const lines = [`curl -sS -X ${operation.method} '${origin}${path}' \\`];
  lines.push(`  -H 'x-access-token: $CALLBOARD_KEY' \\`);
  if (operation.requestExample !== undefined) {
    lines.push(`  -H 'content-type: application/json' \\`);
    lines.push(`  -d '${JSON.stringify(operation.requestExample)}'`);
  } else {
    lines[lines.length - 1] = `  -H 'x-access-token: $CALLBOARD_KEY'`;
  }
  return lines.join("\n");
}
