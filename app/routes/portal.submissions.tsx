/**
 * Portal → Submissions. The speaker's own abstracts with their decision status.
 *
 * Sessionboard opens a right slide-over with `Details | Participants` tabs. A
 * slide-over is client state for content that has a perfectly good URL, so this
 * expands inline with `<details>` instead: no JS, deep-linkable, and it works
 * at 375px where a 400px drawer does not.
 */
import { Link } from "react-router";

import { Card, EmptyState, StatusPill } from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import { renderMarkdown } from "~/lib/markdown";
import { statusPresentation } from "~/lib/portal-progress";
import { parseFormSettings } from "~/lib/form-schema";
import {
  SPEAKER_EDIT_LOCK_COPY,
  speakerEditLockReason,
} from "~/lib/portal/submission-edit";
import { loadSubmissions, loadTasks, portalContext } from "~/lib/portal/portal.server";
import { getDb } from "~/db/client.server";
import { forms, sessionParticipants, sessions, people, tracks } from "~/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Route } from "./+types/portal.submissions";

export function meta() {
  return [{ title: "Your submissions — callboard" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { actor, event } = await portalContext(request);
  const [summaries, tasks] = await Promise.all([
    loadSubmissions(actor.person.id, event.id),
    loadTasks(actor.person.id, event.id),
  ]);

  const ids = summaries.map((row) => row.id);
  const db = getDb();

  const [details, participants] = await Promise.all([
    ids.length
      ? db
          .select({
            id: sessions.id,
            description: sessions.description,
            videoUrl: sessions.videoUrl,
            track: tracks.name,
            /*
             * SERVER ONLY, and it must stay that way: `loadSubmissions` hands
             * back the speaker-facing projection, but the edit lock and the
             * lock COPY are decisions about the real review state. Computing
             * them off the projected status would silently reopen editing on a
             * queued proposal — a visible behaviour change, and a second leak.
             * Nothing below returns this field; the payload carries only
             * `summary.status`, which is already masked.
             */
            reviewStatus: sessions.status,
            // The owning form's deadline policy rides along on the join this
            // query already does. Without it the list says "Edit" and the edit
            // page says "locked", which is the deadline feature failing exactly
            // where a speaker looks first.
            formClosesAt: forms.closesAt,
            formSettings: forms.settings,
          })
          .from(sessions)
          .leftJoin(tracks, eq(tracks.id, sessions.trackId))
          .leftJoin(forms, eq(forms.id, sessions.formId))
          .where(and(inArray(sessions.id, ids), isNull(sessions.deletedAt)))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({
            sessionId: sessionParticipants.sessionId,
            role: sessionParticipants.role,
            name: people.fullName,
            email: people.email,
          })
          .from(sessionParticipants)
          .innerJoin(people, eq(people.id, sessionParticipants.personId))
          .where(inArray(sessionParticipants.sessionId, ids))
      : Promise.resolve([]),
  ]);

  const detailById = new Map(details.map((row) => [row.id, row]));

  return {
    eventName: event.name,
    submissions: summaries.map((summary) => {
      const detail = detailById.get(summary.id);
      // The unprojected status, for server-side decisions only. The detail
      // query selects the same rows as `loadSubmissions`, so the fallback is
      // unreachable; it fails toward the masked value if that ever stops.
      const reviewStatus = detail?.reviewStatus ?? summary.status;
      const lockReason = speakerEditLockReason({
        status: reviewStatus,
        closesAt: detail?.formClosesAt?.getTime() ?? null,
        policy: parseFormSettings(detail?.formSettings).editDeadline,
      });

      return {
        ...summary,
        descriptionHtml: renderMarkdown(detail?.description ?? null),
        videoUrl: detail?.videoUrl ?? null,
        track: detail?.track ?? null,
        participants: participants
          .filter((row) => row.sessionId === summary.id)
          .map((row) => ({ role: row.role, name: row.name ?? row.email })),
        editable: summary.isPrimary === true && lockReason === null,
        /*
         * Review-process state only, never decision state. A speaker whose
         * proposal is staged for a decision must not learn from this sentence
         * that a decision has been staged — that is the organizer's "inform"
         * step to take, and this copy is the only thing standing in front of it.
         */
        editReason:
          reviewStatus === "pending" && summary.isPrimary !== true
            ? "Only the primary submitter can edit this proposal."
            : reviewStatus === "draft"
              ? "This draft can be resumed from its original submission link."
              : lockReason
                ? SPEAKER_EDIT_LOCK_COPY[lockReason]
                : "Editing is closed for this submission.",
        openTasks: tasks.filter(
          (task) =>
            task.sessionId === summary.id &&
            task.status !== "complete" &&
            task.status !== "waived",
        ).length,
      };
    }),
  };
}

export default function PortalSubmissions({ loaderData }: Route.ComponentProps) {
  const { eventName, submissions } = loaderData;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Submissions</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Everything you submitted to {eventName}, and where each one stands.
        </p>
      </header>

      {submissions.length === 0 ? (
        <EmptyState title="No submissions yet">
          When you submit a talk, it appears here with its review status. Nothing has been
          submitted from this account.
        </EmptyState>
      ) : (
        submissions.map((submission) => {
          const shown = statusPresentation(submission.status);
          return (
            <Card
              key={submission.id}
              title={`${submission.friendlyId ? `${submission.friendlyId} — ` : ""}${submission.title}`}
              tone="plain"
            >
              <div id={submission.id} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={shown.tone} glyph={shown.glyph}>
                    {shown.label}
                  </StatusPill>
                  {submission.format ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {submission.format}
                    </span>
                  ) : null}
                  {submission.track ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      · {submission.track}
                    </span>
                  ) : null}
                </div>

                <p className="text-sm text-gray-600 dark:text-gray-400">{shown.hint}</p>

                {submission.editable ? (
                  <p>
                    <Link
                      to={"/portal/submissions/" + submission.id + "/edit"}
                      className="inline-flex rounded border border-gray-300 px-3 py-1.5 text-sm font-medium dark:border-gray-700"
                    >
                      Edit submission
                    </Link>
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">{submission.editReason}</p>
                )}

                {submission.openTasks > 0 ? (
                  <p className="text-sm">
                    <Link to="/portal/tasks" className="font-medium text-blue-700 underline dark:text-blue-300">
                      {submission.openTasks} outstanding task
                      {submission.openTasks === 1 ? "" : "s"} for this talk →
                    </Link>
                  </p>
                ) : null}

                <details className="rounded-lg border border-gray-200 dark:border-gray-800">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Details and participants
                  </summary>
                  <div className="space-y-3 border-t border-gray-200 px-3 py-3 dark:border-gray-800">
                    {submission.descriptionHtml ? (
                      <div>
                        <h3 className={`${eyebrowClass} tracking-wide`}>Abstract</h3>
                        <div
                          className="prose-portal mt-1 text-sm"
                          dangerouslySetInnerHTML={{ __html: submission.descriptionHtml }}
                        />
                      </div>
                    ) : null}
                    {submission.videoUrl ? (
                      <p className="text-sm">
                        Video pitch:{" "}
                        <a href={submission.videoUrl} className="underline" rel="noopener noreferrer">
                          {submission.videoUrl}
                        </a>
                      </p>
                    ) : null}
                    <div>
                      <h3 className={`${eyebrowClass} tracking-wide`}>Participants</h3>
                      <ul className="mt-1 text-sm">
                        {submission.participants.map((participant) => (
                          <li key={`${participant.name}-${participant.role}`}>
                            {participant.name}{" "}
                            <span className="text-gray-500">
                              ({participant.role.replace(/_/g, " ")})
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </details>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
