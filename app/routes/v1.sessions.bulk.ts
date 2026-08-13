/**
 * `POST /v1/event/{eventId}/sessions/bulk` — up to 100 ops, partial success.
 *
 * The response always has 200 status even when items failed: the request itself
 * succeeded, and the per-item `status` plus the `stats` block is where the
 * outcome lives. A 4xx for "3 of 100 rows were bad" would force clients to
 * re-send the 97 good ones.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, readJsonBody } from "~/lib/api/envelope";
import { bulkSessions } from "~/lib/api/sessions.server";
import type { Route } from "./+types/v1.sessions.bulk";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const eventId = params.eventId;
  const principal = await requireApiKey(request, { eventId, scope: "write:sessions" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const result = await bulkSessions(eventId, body.operations, {
    personId: null,
    name: `API key "${principal.keyName}"`,
  });
  if (!result.ok) return apiError(400, "ValidationError", result.message);

  return apiJson(result.value);
}

export async function loader() {
  return methodNotAllowed(["POST"]);
}
