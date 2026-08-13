/**
 * JSON 404 floor for unknown `/v1/*` paths.
 *
 * This route deliberately does not require an API key. Returning 401 before
 * 404 would imply that a nonexistent path might exist and make a typo look
 * like an authentication problem.
 */
import { apiError } from "~/lib/api/envelope";
import type { Route } from "./+types/v1.catchall";

function notFound(request: Request): Response {
  const path = new URL(request.url).pathname;
  return apiError(404, "NotFoundError", `No API route exists at ${path}.`);
}

export async function loader({ request }: Route.LoaderArgs) {
  return notFound(request);
}

export async function action({ request }: Route.ActionArgs) {
  return notFound(request);
}
