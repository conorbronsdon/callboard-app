import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Link } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, LaneStub } from "~/components/shell";
import { chunkForBind, getDb } from "~/db/client.server";
import {
  forms,
  people,
  reviewAssignments,
  reviewRounds,
  sessionParticipants,
  sessions,
  tasks,
} from "~/db/schema";
import { isScheduled } from "~/lib/agenda/conflicts";
import { loadProgramme } from "~/lib/agenda/programme.server";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import {
  deriveProgrammeReadiness,
  type ProgrammeReadiness,
  type ReadinessStatus,
} from "~/lib/programme-readiness";
import type { Route } from "./+types/admin.index";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function meta() {
  return [{ title: "Dashboard — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { event: null, counts: null, readiness: null };

  const weekAgo = new Date(Date.now() - WEEK_MS);
  const db = getDb();
  const [
    abstracts,
    accepted,
    openTasks,
    formRows,
    thisWeek,
    abstractRows,
    assignmentRows,
    speakerRows,
    programme,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .where(and(eq(sessions.eventId, event.id), eq(sessions.isAbstract, true))),
    // Abstracts only. An accepted abstract and the program session composed
    // from it are two rows with status `accepted` (DECISIONS.md #3), so without
    // this filter the tile double-counts every acceptance.
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          eq(sessions.status, "accepted"),
        ),
      ),
    // "Outstanding" means not finished: a task a speaker has started but not
    // submitted is still outstanding, and `waived`/`complete` are not.
    db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(eq(tasks.eventId, event.id), inArray(tasks.status, ["pending", "in_progress"])),
      ),
    // A closed CFP is a normal later lifecycle state, so retain every state
    // instead of treating "not open" as equivalent to "not configured".
    db
      .select({ status: forms.status, n: sql<number>`count(*)` })
      .from(forms)
      .where(and(eq(forms.eventId, event.id), eq(forms.surface, "cfp")))
      .groupBy(forms.status),
    db
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          gte(sessions.createdAt, weekAgo),
        ),
      ),
    db
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      ),
    db
      .select({ sessionId: reviewAssignments.sessionId })
      .from(reviewAssignments)
      .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssignments.roundId))
      .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
      .where(
        and(
          eq(reviewRounds.eventId, event.id),
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          eq(sessions.status, "pending"),
          isNull(sessions.deletedAt),
        ),
      ),
    db
      .select({ id: people.id, bio: people.bio, headshotKey: people.headshotKey })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          eq(sessions.status, "accepted"),
          isNull(sessions.deletedAt),
          inArray(sessionParticipants.role, ["speaker", "co_speaker"]),
        ),
      ),
    loadProgramme(event.id),
  ]);

  const formCounts = new Map(formRows.map((row) => [row.status, Number(row.n)]));
  const pendingIds = abstractRows
    .filter((row) => row.status === "pending")
    .map((row) => row.id);
  const assignedPendingIds = new Set(assignmentRows.map((row) => row.sessionId));
  const acceptedProgramme = programme.sessions.filter((session) => session.status === "accepted");
  const acceptedSessionIds = new Set(acceptedProgramme.map((session) => session.id));
  const acceptedSpeakerProfiles = new Map(
    speakerRows.map((row) => [row.id, { bio: row.bio, headshotKey: row.headshotKey }]),
  );
  const acceptedSpeakerIds = [...acceptedSpeakerProfiles.keys()];
  // Travel forms and other onboarding work can be person-level, so scope
  // tasks by accepted event speakers rather than requiring a session_id.
  // One parameter per accepted speaker, plus the event id and two statuses —
  // unbounded on a real event, so chunk it under D1's cap.
  const openAcceptedTaskRows = (
    await Promise.all(
      chunkForBind(acceptedSpeakerIds, 1).map((chunk) =>
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.eventId, event.id),
              inArray(tasks.personId, chunk),
              inArray(tasks.status, ["pending", "in_progress"]),
            ),
          ),
      ),
    )
  ).flat();

  const readiness = deriveProgrammeReadiness({
    cfpForms: [...formCounts.values()].reduce((sum, count) => sum + count, 0),
    openCfpForms: formCounts.get("open") ?? 0,
    abstracts: abstractRows.length,
    pendingAbstracts: pendingIds.length,
    unassignedPendingAbstracts: pendingIds.filter((id) => !assignedPendingIds.has(id)).length,
    queuedDecisions: abstractRows.filter(
      (row) => row.status === "accept_queue" || row.status === "decline_queue",
    ).length,
    acceptedSpeakers: acceptedSpeakerProfiles.size,
    incompleteSpeakerProfiles: [...acceptedSpeakerProfiles.values()].filter(
      (person) => !person.bio?.trim() || !person.headshotKey,
    ).length,
    outstandingSpeakerTasks: openAcceptedTaskRows.length,
    acceptedSessions: acceptedProgramme.length,
    unscheduledAcceptedSessions: acceptedProgramme.filter(
      (session) => !isScheduled(session) || !session.roomId,
    ).length,
    unpublishedAcceptedSessions: acceptedProgramme.filter((session) => !session.isPublic).length,
    agendaConflicts: programme.conflicts.filter(
      (conflict) => acceptedSessionIds.has(conflict.a.id) || acceptedSessionIds.has(conflict.b.id),
    ).length,
  });

  return {
    event: { name: event.name, slug: event.slug },
    readiness,
    counts: {
      abstracts: abstracts[0]?.n ?? 0,
      accepted: accepted[0]?.n ?? 0,
      openTasks: openTasks[0]?.n ?? 0,
      openForms: formCounts.get("open") ?? 0,
      submissionsThisWeek: thisWeek[0]?.n ?? 0,
    },
  };
}

export default function AdminDashboard({ loaderData }: Route.ComponentProps) {
  const { event, counts, readiness } = loaderData;

  if (!event || !counts || !readiness) {
    return (
      <LaneStub lane="No event yet">
        Once an event is set up, its submissions, speakers and forms are summarised here.
      </LaneStub>
    );
  }

  return (
    <div className="space-y-6">
      <ProgrammeReadinessPanel readiness={readiness} />

      {/*
        * ⚠️ mobile-organizer.spec.ts:44-46 reads these by role=link, filters on
        * the label and calls Number() on the card's ONLY <dd>. The card must
        * stay an <a> whose <dd> contains the bare number — no unit, no suffix.
        */}
      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: "Submissions",
            value: counts.abstracts,
            to: "/admin/submissions",
            icon: "inbox" as const,
          },
          {
            label: "Accepted abstracts",
            value: counts.accepted,
            to: "/admin/submissions?tab=accepted",
            icon: "check" as const,
          },
          {
            label: "Outstanding speaker tasks",
            value: counts.openTasks,
            to: "/admin/tasks",
            icon: "clock" as const,
          },
        ].map((stat) => (
          <Link
            key={stat.label}
            to={stat.to}
            className="rounded-xl border border-gray-200 bg-white p-4 shadow-card transition hover:border-blue-300 sm:p-5 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
          >
            <div className="flex items-start justify-between gap-3">
              <dt className="text-sm text-gray-600 dark:text-gray-400">{stat.label}</dt>
              <KpiIcon icon={stat.icon} />
            </div>
            <dd className="mt-1 text-3xl font-semibold tabular-nums">{stat.value}</dd>
          </Link>
        ))}
      </dl>

      {/* The form builder is the heart of the product, so it gets the biggest
          target on the first screen an organiser sees — not a nav item they
          have to go looking for. */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Form builder</h2>
            <p className="mt-1 max-w-prose text-sm text-gray-600 dark:text-gray-300">
              Build the call for proposals: questions, conditional logic, character limits,
              participant rules and automatic track routing. Share one link and submissions
              land in review.
            </p>
          </div>
          <Link to="/admin/forms" className={buttonClass("primary")}>
            Open the form builder
          </Link>
        </div>

        {/*
          * Two tiles, not three. The third was "Outstanding tasks" bound to the
          * same `counts.openTasks` as "Outstanding speaker tasks" above it —
          * one number printed twice under two names, which invites the reader
          * to treat them as two facts that happen to agree.
          */}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <BuilderStat
            label="Forms open"
            value={counts.openForms}
            hint={counts.openForms === 0 ? "Nothing is accepting submissions" : "Accepting submissions now"}
            to="/admin/forms?status=open"
          />
          <BuilderStat
            label="Submissions this week"
            value={counts.submissionsThisWeek}
            /* A bare 0 reads as broken. Say which zero it is. */
            hint={
              counts.submissionsThisWeek === 0
                ? "Nothing new in the last 7 days"
                : "Received in the last 7 days"
            }
            to="/admin/submissions"
          />
        </dl>
      </section>
    </div>
  );
}

/*
 * Same shape as the portal's StatusPill (components/portal-ui.tsx): pale fill,
 * dark text of the same hue, inset ring. The ring is what stops a pale chip
 * from dissolving into a white card.
 */
const STATUS_STYLES: Record<ReadinessStatus, string> = {
  ready:
    "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-600/20 ring-inset dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30",
  attention:
    "bg-amber-100 text-amber-900 ring-1 ring-amber-600/20 ring-inset dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-400/30",
  waiting:
    "bg-gray-100 text-gray-700 ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-400/30",
  closed:
    "bg-blue-100 text-blue-800 ring-1 ring-blue-600/20 ring-inset dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-400/30",
};

/** Left rail per stage status. Decoration on top of the chip, never instead of it. */
const STAGE_RAIL: Record<ReadinessStatus, string> = {
  ready: "border-l-emerald-500",
  attention: "border-l-amber-500",
  waiting: "border-l-gray-300 dark:border-l-gray-600",
  closed: "border-l-blue-500",
};

/** 20px stroked KPI glyph, top-right of each stat card. Decorative. */
function KpiIcon({ icon }: { icon: "inbox" | "check" | "clock" }) {
  const paths = {
    inbox: "M3.5 13.5h4l1.5 2.5h6l1.5-2.5h4M4.5 13.5 6.8 5.4A1.5 1.5 0 0 1 8.2 4.3h7.6a1.5 1.5 0 0 1 1.4 1.1l2.3 8.1v4a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5z",
    check: "M20.5 6.5 10 17l-5.5-5.5",
    clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17M12 7v5.3l3.3 2",
  };
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      /* gray-300 on white was a ghost — present enough to be noticed as
         something unreadable, not present enough to read as a glyph. */
      className="shrink-0 text-gray-400 dark:text-gray-500"
    >
      <path d={paths[icon]} />
    </svg>
  );
}

export function ProgrammeReadinessPanel({ readiness }: { readiness: ProgrammeReadiness }) {
  return (
    <section
      aria-labelledby="programme-readiness-heading"
      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-card sm:p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={eyebrowClass}>
            Producer checklist
          </p>
          <h2
            id="programme-readiness-heading"
            className="mt-1 text-xl font-semibold tracking-tight"
          >
            Programme readiness
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-300">
            {readiness.summary}
          </p>
        </div>
        {/*
         * The verdict, not a badge. At `text-xs` in the top-right corner this
         * was quieter than the four stage chips it summarises, so the one line
         * on the dashboard that says "here is what is wrong" was the least
         * visible thing on it. A glyph and a size bump; the word still carries
         * the meaning, so colour is not doing the work alone.
         */}
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold whitespace-nowrap ${
            readiness.attentionCount > 0 ? STATUS_STYLES.attention : STATUS_STYLES.ready
          }`}
        >
          <span aria-hidden="true">{readiness.attentionCount > 0 ? "!" : "✓"}</span>
          {readiness.attentionCount > 0
            ? `${readiness.attentionCount} need attention`
            : "No current blockers"}
        </span>
      </div>

      <ol className="mt-5 grid gap-4 md:grid-cols-2">
        {readiness.stages.map((stage, index) => (
          <li
            key={stage.id}
            /*
             * The rail restates the stage's status at the edge of the card, so
             * a glance down the column shows where the programme is stuck. It
             * is decoration only: the chip and its label still carry the
             * meaning, because colour alone is not a status.
             */
            /*
             * `flex flex-col` so the action can be pinned. In a stretched grid
             * the four stages take the tallest one's height, and the button sat
             * wherever its own text ran out — stage 1's "Manage open forms"
             * floated with 60px of dead card under it while stage 2's sat on
             * the edge. A checklist whose actions do not line up does not read
             * as a checklist.
             */
            className={`flex min-w-0 flex-col rounded-lg border border-gray-200 border-l-4 bg-gray-50/60 p-4 dark:border-gray-800 dark:bg-gray-950/40 ${STAGE_RAIL[stage.status]}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">
                <span className="mr-2 text-gray-400 tabular-nums" aria-hidden="true">
                  {index + 1}.
                </span>
                {stage.title}
              </h3>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[stage.status]}`}
              >
                {stage.statusLabel}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-200">{stage.summary}</p>
            <ul className="mt-2 space-y-1 text-sm leading-6 text-gray-500 dark:text-gray-400">
              {stage.details.map((detail) => (
                <li key={detail} className="flex gap-2">
                  <span aria-hidden="true">•</span>
                  <span>{detail}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-4">
              <a href={stage.to} className={`min-h-11 ${buttonClass("secondary")}`}>
                {stage.actionLabel}
              </a>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BuilderStat({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: number;
  hint: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      /* Same padding as the KPI cards above. These two carried `px-3 py-2.5`
         against their `p-4 sm:p-5`, so one screen showed the same object —
         label, number, link — at two densities four inches apart. */
      className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
    >
      <dt className="text-sm text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{hint}</p>
    </Link>
  );
}
