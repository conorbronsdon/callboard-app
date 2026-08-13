/**
 * `GET /v1/events` — the entry point for every integration.
 *
 * Keys are minted per event (schema `api_keys.event_id` is NOT NULL), so this
 * returns exactly the one event the presented key can reach. Sessionboard's
 * version is org-scoped and returns many; the envelope is identical either way,
 * so a client that pages this list keeps working if scoping ever widens.
 */
import { eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events } from "~/db/schema";
import { methodNotAllowed, requireApiKey } from "~/lib/api/auth.server";
import { apiJson, envelope, parsePaging } from "~/lib/api/envelope";
import { serializeEvent } from "~/lib/api/serialize";
import type { Route } from "./+types/v1.events";

export async function loader({ request }: Route.LoaderArgs) {
  const principal = await requireApiKey(request, { scope: "read:events" });
  const url = new URL(request.url);
  const paging = parsePaging({
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize") ?? url.searchParams.get("page_size"),
  });

  const rows = await getDb().select().from(events).where(eq(events.id, principal.eventId));
  const results = rows
    .slice(paging.offset, paging.offset + paging.pageSize)
    .map((event) => serializeEvent(event, { origin: url.origin }));

  return apiJson(envelope(results, rows.length, paging));
}

export async function action() {
  return methodNotAllowed(["GET"]);
}
