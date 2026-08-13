/**
 * `GET /ready` — a generic, read-only post-deploy readiness probe.
 *
 * The public response never identifies the missing secret, binding, table, or
 * column. Exact failures are available only in Worker logs.
 */
import { methodNotAllowed } from "~/lib/api/auth.server";
import { checkRuntimeReadiness } from "~/lib/readiness.server";

export async function loader() {
  const readiness = await checkRuntimeReadiness();
  return Response.json(readiness, {
    status: readiness.ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export async function action() {
  return methodNotAllowed(["GET"]);
}
