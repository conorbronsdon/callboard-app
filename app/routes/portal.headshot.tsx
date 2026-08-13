/**
 * `GET /portal/headshot/:personId` — the CURRENT headshot for a person.
 *
 * A convenience alias over `/api/uploads/:id`: `people.headshot_key` is the
 * single source for which photo is current, so the avatar in the layout can
 * render without the loader first resolving an upload id.
 *
 * Same access rule as any other upload — resolved through the shared
 * `canReadUpload` predicate so this route cannot drift from the API one.
 */
import { eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { people, uploads } from "~/db/schema";
import { requireUser } from "~/lib/auth/auth.server";
import { canReadUpload } from "~/lib/portal-access";
import { getObject, objectResponse } from "~/lib/r2.server";
import type { Route } from "./+types/portal.headshot";

export async function loader({ request, params }: Route.LoaderArgs) {
  const viewer = await requireUser(request);
  const db = getDb();

  const person = await db.query.people.findFirst({ where: eq(people.id, params.personId) });
  if (!person?.headshotKey) throw new Response("No headshot.", { status: 404 });

  const row = await db.query.uploads.findFirst({
    where: eq(uploads.key, person.headshotKey),
  });
  if (!row || !canReadUpload(row, viewer)) throw new Response("Not found.", { status: 404 });

  const object = await getObject(person.headshotKey);
  if (!object) throw new Response("Not found.", { status: 404 });

  return objectResponse(object, false);
}
