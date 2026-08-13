/**
 * `POST /v1/event/{eventId}/sessions/create`.
 *
 * The `/create` suffix exists because POST on the collection already means
 * "search" (Sessionboard's weakest idea, but wire compatibility is the point —
 * research/sessionboard-api.md §1). This is also the submission-ingest API:
 * `is_abstract: true` creates a CFP abstract.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, readJsonBody } from "~/lib/api/envelope";
import { createSession, parseSessionBody } from "~/lib/api/sessions.server";
import { serializeSession } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.sessions.create";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "write:sessions" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return apiError(400, "BadRequestError", "Body must be valid JSON.");
  }

  const parsed = parseSessionBody(body, "create");
  if (!parsed.ok) return apiError(400, "ValidationError", parsed.message);

  const created = await createSession(eventId, parsed.values);
  if (!created.ok) return apiError(400, "ValidationError", created.error.message);

  return apiJson(
    serializeSession(created.value, { origin: new URL(request.url).origin }),
    201,
  );
}

export async function loader() {
  return methodNotAllowed(["POST"]);
}
