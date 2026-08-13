/**
 * `POST /v1/event/{eventId}/sessions` and `/sessions/search` — the workhorse.
 *
 * Search is a POST with a filter body, not a GET with query params. That is
 * Sessionboard's convention (research/sessionboard-api.md §1) and it is the one
 * piece of their design most worth copying: filters nest (date ranges, arrays),
 * and nested filters in a query string are where every API's ergonomics die.
 *
 * `/sessions/search` is the primary path (PLAN.md §4 WS7 keep-list); the bare
 * collection POST is the wire-compatible alias for clients written against
 * Sessionboard. Both run this module — see `v1.sessions.search.ts`.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, envelope, parsePaging, readJsonBody } from "~/lib/api/envelope";
import {
  normalizeSessionFilters,
  normalizeSessionSort,
  searchSessions,
} from "~/lib/api/sessions.server";
import { serializeSession } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.sessions";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:sessions" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const paging = parsePaging(body);
  const filters = normalizeSessionFilters(body.filters);
  const sort = normalizeSessionSort(body.sort);

  const { sessions, total } = await searchSessions(eventId, filters, sort, paging);
  const origin = new URL(request.url).origin;

  return apiJson(
    envelope(
      sessions.map((session) => serializeSession(session, { origin })),
      total,
      paging,
    ),
  );
}

/** A GET here is a client that expected query-param search. Say so. */
export async function loader() {
  return methodNotAllowed(["POST"]);
}
