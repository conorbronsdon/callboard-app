import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { getDb } from "~/db/client.server";
import { people, reviewTeamMembers, reviewTeams } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import { startReviewerImpersonationCookie } from "~/lib/review/impersonation.server";
import type { Route } from "./+types/review.impersonate";

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const form = await request.formData();
  const personId = String(form.get("personId") ?? "");

  const [target] = await getDb()
    .select({ id: people.id })
    .from(reviewTeamMembers)
    .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
    .innerJoin(people, eq(people.id, reviewTeamMembers.personId))
    .where(
      and(
        eq(reviewTeamMembers.personId, personId),
        eq(reviewTeams.eventId, event.id),
      ),
    )
    .limit(1);
  if (!target) throw new Response("No reviewer exists for this event.", { status: 404 });

  return redirect(`/review?event=${encodeURIComponent(event.slug)}`, {
    headers: { "set-cookie": await startReviewerImpersonationCookie(request, admin.id, target.id) },
  });
}

export async function loader() {
  return redirect("/admin/view-as");
}
