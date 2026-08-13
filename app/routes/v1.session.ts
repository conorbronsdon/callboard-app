/**
 * `GET | PUT | DELETE /v1/event/{eventId}/sessions/{sessionId}`.
 *
 * DELETE is SOFT: the row keeps its history and `POST .../restore` puts it
 * back. Sessionboard does the same on every major resource and most clones skip
 * it — a CFP that can lose a submission to a mis-click is not a CFP.
 */
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiError, apiJson, readJsonBody } from "~/lib/api/envelope";
import { getSession, parseSessionBody, softDeleteSession, updateSession } from "~/lib/api/sessions.server";
import { serializeSession } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.session";

export async function loader({ request, params }: Route.LoaderArgs) {
  const eventId = params.eventId;
  await requireApiKey(request, { eventId, scope: "read:sessions" });

  const session = await getSession(eventId, params.sessionId);
  if (!session) return apiError(404, "NotFoundError", "Session not found.");

  return apiJson(serializeSession(session, { origin: new URL(request.url).origin }));
}

export async function action({ request, params }: Route.ActionArgs) {
  const eventId = params.eventId;
  const origin = new URL(request.url).origin;

  if (request.method === "PUT") {
    await requireApiKey(request, { eventId, scope: "write:sessions" });

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return apiError(400, "BadRequestError", "Body must be valid JSON.");
    }

    const parsed = parseSessionBody(body, "update");
    if (!parsed.ok) return apiError(400, "ValidationError", parsed.message);

    const updated = await updateSession(
      eventId,
      params.sessionId,
      parsed.values,
      parsed.expectedUpdatedAt,
      parsed.publishOverride,
      parsed.publishForce,
    );
    if (!updated.ok) {
      const { code, message } = updated.error;
      if (code === "not_found") return apiError(404, "NotFoundError", message);
      if (code === "conflict") return apiError(409, "ConflictError", message);
      return apiError(400, "ValidationError", message);
    }
    return apiJson(serializeSession(updated.value, { origin }));
  }

  if (request.method === "DELETE") {
    await requireApiKey(request, { eventId, scope: "write:sessions" });
    const deleted = await softDeleteSession(eventId, params.sessionId);
    if (!deleted.ok) return apiError(404, "NotFoundError", deleted.error.message);
    return apiJson(deleted.value);
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}
