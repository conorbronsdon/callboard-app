/**
 * Admin → View as speaker.
 *
 * The launcher for impersonation. Lives on its own WS3-owned route rather than
 * bolted onto `admin.speakers.tsx` (WS6's screen) so the two lanes do not edit
 * the same file; WS6 can drop a link here when their dashboard lands.
 */
import { Form } from "react-router";
import { asc, eq } from "drizzle-orm";

import { EmptyState, buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import {
  eventPeople,
  people,
  reviewTeamMembers,
  reviewTeams,
  tasks,
} from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.viewas";

export interface ReviewerPreviewRow {
  id: string;
  email: string;
  fullName: string | null;
  teams: string[];
}

/**
 * `eventSlug` is what keeps this button honest under the event switcher: the
 * form posts to `/review/impersonate`, which is OUTSIDE `/admin`, so the
 * selection cookie (Path=/admin) is not sent with it. Carrying the slug in the
 * query string makes the action resolve the same event as the page the
 * organizer is looking at. Optional so the accessibility test that renders this
 * table standalone keeps its plain `/review/impersonate` action.
 */
export function ReviewerPreviewTable({
  reviewers,
  eventSlug,
}: {
  reviewers: ReviewerPreviewRow[];
  eventSlug?: string | null;
}) {
  const impersonateAction = eventSlug
    ? `/review/impersonate?event=${encodeURIComponent(eventSlug)}`
    : "/review/impersonate";

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-xs tracking-wide text-gray-600 uppercase dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          <tr>
            <th scope="col" className="px-3 py-2">Reviewer</th>
            <th scope="col" className="px-3 py-2">Teams</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
          {reviewers.map((reviewer) => (
            <tr key={reviewer.id}>
              <td className="px-3 py-2">
                <div className="font-medium">{reviewer.fullName ?? reviewer.email}</div>
                <div className="text-xs text-gray-500">{reviewer.email}</div>
              </td>
              <td className="px-3 py-2 text-xs">{reviewer.teams.join(", ")}</td>
              <td className="px-3 py-2 text-right">
                <form method="post" action={impersonateAction}>
                  <input type="hidden" name="personId" value={reviewer.id} />
                  <button type="submit" className={buttonClass("secondary")}>View as reviewer</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();

  const [rows, taskRows, reviewerRows] = await Promise.all([
    db
      .select({
        id: people.id,
        email: people.email,
        fullName: people.fullName,
        company: people.company,
        role: people.role,
        hasBio: people.bio,
        hasHeadshot: people.headshotKey,
      })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(eq(eventPeople.eventId, event.id))
      .orderBy(asc(people.fullName))
      .limit(200),
    db
      .select({ personId: tasks.personId, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.eventId, event.id))
      .limit(1000),
    db
      .select({
        id: people.id,
        email: people.email,
        fullName: people.fullName,
        teamName: reviewTeams.name,
      })
      .from(reviewTeamMembers)
      .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
      .innerJoin(people, eq(people.id, reviewTeamMembers.personId))
      .where(eq(reviewTeams.eventId, event.id))
      .orderBy(asc(people.fullName), asc(reviewTeams.name))
      .limit(500),
  ]);

  const reviewers = new Map<string, {
    id: string;
    email: string;
    fullName: string | null;
    teams: string[];
  }>();
  for (const row of reviewerRows) {
    const existing = reviewers.get(row.id);
    if (existing) existing.teams.push(row.teamName);
    else reviewers.set(row.id, { ...row, teams: [row.teamName] });
  }

  return {
    eventName: event.name,
    eventSlug: event.slug,
    reviewers: [...reviewers.values()],
    speakers: rows
      .filter((row) => row.role !== "admin")
      .map((row) => {
        const mine = taskRows.filter((task) => task.personId === row.id);
        return {
          id: row.id,
          email: row.email,
          fullName: row.fullName,
          company: row.company,
          hasBio: Boolean(row.hasBio),
          hasHeadshot: Boolean(row.hasHeadshot),
          openTasks: mine.filter((task) => task.status !== "complete" && task.status !== "waived")
            .length,
          totalTasks: mine.length,
        };
      }),
  };
}

export default function AdminViewAs({ loaderData }: Route.ComponentProps) {
  const { eventName, eventSlug, speakers, reviewers } = loaderData;

  /*
   * Same reason as `ReviewerPreviewTable` above: `/portal/impersonate` is
   * outside `/admin`, so the selection cookie (Path=/admin) is neither sent nor
   * read there. Without the slug the action resolved the DEFAULT event while
   * this page's speaker list was scoped to the selected one — a 200 and an
   * empty portal for a speaker the organizer can see three columns to the left.
   * The action binds the event into the view-as cookie, which is what carries
   * it across the portal's five tabs.
   */
  const impersonateAction = `/portal/impersonate?event=${encodeURIComponent(eventSlug)}`;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold">View as speaker</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Open the speaker portal exactly as this person sees it — useful for answering
          "where do I upload my slides?" without asking for a screenshot. A banner stays
          pinned to the top of every portal page, and <strong>Back to Admin Mode</strong>{" "}
          returns you here without signing in again.
        </p>
      </header>

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold">Reviewer workspace</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Check the assigned-only scoring experience without exposing organizer navigation.
          </p>
        </div>
        {reviewers.length === 0 ? (
          <EmptyState title="No reviewers yet">
            Add people to a review team before opening the reviewer workspace.
          </EmptyState>
        ) : (
          <ReviewerPreviewTable reviewers={reviewers} eventSlug={eventSlug} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Speaker portal</h2>
      {speakers.length === 0 ? (
        <EmptyState title="No speakers yet">
          Nobody is attached to {eventName} yet, so there is no one to view the portal as.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs tracking-wide text-gray-600 uppercase dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">Speaker</th>
                <th className="px-3 py-2">Onboarding</th>
                <th className="px-3 py-2">Profile</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {speakers.map((speaker) => (
                <tr key={speaker.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{speaker.fullName ?? speaker.email}</div>
                    <div className="text-xs text-gray-500">
                      {speaker.company ? `${speaker.company} · ` : ""}
                      {speaker.email}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {speaker.totalTasks === 0
                      ? "No tasks"
                      : `${speaker.totalTasks - speaker.openTasks}/${speaker.totalTasks} done`}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {speaker.hasBio ? "bio ✓" : "bio ✗"} · {speaker.hasHeadshot ? "photo ✓" : "photo ✗"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Form method="post" action={impersonateAction}>
                      <input type="hidden" name="personId" value={speaker.id} />
                      <button type="submit" className={buttonClass("secondary")}>
                        View as speaker
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </section>
    </div>
  );
}
