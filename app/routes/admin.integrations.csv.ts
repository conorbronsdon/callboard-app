/**
 * `GET /admin/integrations/accelevents.csv?file=speakers|sessions`
 *
 * The two halves of the linked pair, as downloads. Admin session required — the
 * files carry every speaker's email and bio, so this is not a public export.
 *
 * Generating the pair is recorded in `sync_state`, which is what gives the
 * Integrations panel a history rather than a button with no memory.
 */
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import { buildAccelCsvPair, recordCsvGeneration } from "~/lib/integrations/accelevents.server";
import type { Route } from "./+types/admin.integrations.csv";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);

  const which = new URL(request.url).searchParams.get("file") ?? "sessions";
  if (which !== "speakers" && which !== "sessions") {
    throw new Response("Pass ?file=speakers or ?file=sessions.", { status: 400 });
  }

  const pair = await buildAccelCsvPair(event.id);
  await recordCsvGeneration(event.id, pair);

  const build = pair[which];
  return new Response(build.csv, {
    headers: {
      // No BOM: their importer is not documented to tolerate one, and the pair
      // is meant for their uploader rather than for opening in Excel.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${build.filename}"`,
      "cache-control": "no-store",
    },
  });
}
