/**
 * Portal home.
 *
 * Order is the product decision here: **acceptance status first** ("a key part"
 * — buyer's brief), then the outstanding-task count, then ONE next action. Sessionboard
 * leads with a two-column card grid and leaves priority to the reader; a
 * speaker who opens this page should be able to answer "am I in?" and "what do
 * I do now?" without scrolling on a phone.
 */
import { Link } from "react-router";

import {
  ButtonLink,
  Card,
  EmptyState,
  ProgressMeter,
  StatusPill,
} from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import {
  acceptanceSummary,
  formatDueDate,
  isTaskOverdue,
  nextAction,
  profileCompleteness,
  relativeDue,
  sortTasksForSpeaker,
  statusPresentation,
  taskCounts,
} from "~/lib/portal-progress";
import { loadSubmissions, loadTasks, portalContext } from "~/lib/portal/portal.server";
import type { Route } from "./+types/portal.index";

export function meta() {
  return [{ title: "Speaker portal — callboard" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { actor, event } = await portalContext(request);
  const [submissions, tasks] = await Promise.all([
    loadSubmissions(actor.person.id, event.id),
    loadTasks(actor.person.id, event.id),
  ]);

  return {
    now: Date.now(),
    event: { name: event.name, slug: event.slug },
    // Due dates render in the conference's zone, not the browser's (SPK-05).
    timeZone: event.timezone,
    person: {
      fullName: actor.person.fullName,
      email: actor.person.email,
    },
    submissions,
    tasks,
    profile: profileCompleteness({
      fullName: actor.person.fullName,
      bio: actor.person.bio,
      headshotKey: actor.person.headshotKey,
      company: actor.person.company,
      title: actor.person.title,
      links: (actor.person.links ?? {}) as Record<string, string>,
    }),
  };
}

export default function PortalHome({ loaderData }: Route.ComponentProps) {
  const { now, event, timeZone, person, submissions, tasks, profile } = loaderData;

  const acceptance = acceptanceSummary(submissions);
  const counts = taskCounts(tasks, now);
  const action = nextAction(
    tasks,
    { hasBio: !profile.missing.includes("bio"), hasHeadshot: !profile.missing.includes("headshot") },
    now,
    timeZone,
  );
  const upcoming = sortTasksForSpeaker(tasks, now).slice(0, 4);

  return (
    <div className="space-y-5">
      {/* ─────────── acceptance status, front and centre ─────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900">
        {/* The shared eyebrow, not a fourth hand-rolled `text-xs uppercase`
            variant — and the one on this page had no dark colour at all. */}
        <p className={eyebrowClass}>{event.name}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
          {person.fullName ? `Hi ${person.fullName.split(" ")[0]} — ` : ""}
          {acceptance.headline}
        </h1>

        {/*
         * `<dl>`, not `<div>`. `Stat` renders `<dt>`/`<dd>` pairs, which are
         * only permitted inside a definition list — outside one they are
         * unknown elements, and a screen reader announces three bare numbers
         * with no idea which label belongs to which. The grid moves onto the
         * list; nothing about the layout changes.
         */}
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Submissions" value={acceptance.total} />
          <Stat label="Accepted" value={acceptance.accepted} tone="positive" />
          <Stat
            label="Tasks outstanding"
            value={counts.open}
            tone={counts.overdue > 0 ? "negative" : counts.open > 0 ? "warning" : "positive"}
            note={counts.overdue > 0 ? `${counts.overdue} overdue` : undefined}
          />
        </dl>

        {action ? (
          <div
            className={[
              "mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3",
              action.urgent
                ? "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950"
                : "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950",
            ].join(" ")}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-gray-600 uppercase dark:text-gray-400">
                Next up · {action.reason}
              </p>
              <p className="truncate text-sm font-semibold">{action.label}</p>
            </div>
            <ButtonLink to={action.to}>Do it now</ButtonLink>
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
            <span aria-hidden="true">✓ </span>
            You're all caught up — nothing outstanding.
          </p>
        )}
      </section>

      {/* ─────────── submissions ─────────── */}
      <Card
        title={`My submissions (${submissions.length})`}
        action={
          submissions.length > 0 ? (
            <Link to="/portal/submissions" className="underline">
              View all
            </Link>
          ) : null
        }
      >
        {submissions.length === 0 ? (
          <EmptyState title="No submissions yet">
            Once you submit a talk to {event.name}, its review status shows up here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-800">
            {submissions.slice(0, 4).map((submission) => {
              const shown = statusPresentation(submission.status);
              return (
                <li key={submission.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/portal/submissions#${submission.id}`}
                      className="text-sm font-semibold hover:underline"
                    >
                      {submission.friendlyId ? `${submission.friendlyId} — ` : ""}
                      {submission.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {submission.format ?? "Format to be confirmed"}
                    </p>
                  </div>
                  <StatusPill tone={shown.tone} glyph={shown.glyph}>
                    {shown.label}
                  </StatusPill>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ─────────── tasks + profile ─────────── */}
      <div className="grid gap-5 md:grid-cols-2">
        <Card
          title={`Tasks (${counts.open} open)`}
          action={
            <Link to="/portal/tasks" className="underline">
              View all
            </Link>
          }
        >
          {/* A 100% "Onboarding complete" bar next to "No tasks assigned" is a
              lie of arithmetic: nothing was completed, there was nothing to
              complete. A speaker with no tasks gets told what happens next
              instead of a meter. */}
          {tasks.length > 0 ? (
            <div className="mb-3">
              <ProgressMeter percent={counts.percentComplete} label="Onboarding complete" />
            </div>
          ) : null}
          {tasks.length === 0 ? (
            <EmptyState title="No tasks yet">
              We&rsquo;ll email you when there&rsquo;s something to do — usually right after a
              talk is accepted.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800">
              {upcoming.map((task) => {
                const overdue = isTaskOverdue(task, now);
                const done = task.status === "complete" || task.status === "waived";
                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      to={`/portal/tasks/${task.id}`}
                      className={done ? "text-gray-500 line-through" : "hover:underline"}
                    >
                      {task.title}
                    </Link>
                    {done ? (
                      <span className="text-xs text-gray-500">Done</span>
                    ) : task.dueAt === null ? (
                      <span className="text-xs text-gray-500">No due date</span>
                    ) : (
                      <span
                        className={`text-xs whitespace-nowrap ${overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-gray-500"}`}
                      >
                        {overdue ? "Overdue " : "Due "}
                        {formatDueDate(task.dueAt, timeZone)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="My profile" tone="plain">
          <ProgressMeter percent={profile.percent} label="Profile complete" />
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            {profile.missing.length === 0
              ? "Everything the program team needs is filled in."
              : `Still missing: ${profile.missing.join(", ")}.`}
          </p>
          {/* `mt-auto`, so this card's action lands on the same baseline as the
              taller Tasks card beside it instead of floating mid-panel. */}
          <div className="mt-auto pt-4">
            <ButtonLink to="/portal/profile" variant="secondary">
              Update your bio and photo
            </ButtonLink>
          </div>
        </Card>
      </div>

      {/* Ruled off rather than floating. Centred micro-gray under a card grid,
          this read as a caption that had come loose from something. */}
      {tasks.some((task) => task.dueAt !== null && task.status === "pending") ? (
        <p className="border-t border-gray-200 pt-4 text-center text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          Nearest deadline{" "}
          {relativeDue(
            Math.min(
              ...tasks
                .filter((task) => task.status === "pending" && task.dueAt !== null)
                .map((task) => task.dueAt as number),
            ),
            now,
          )}
          .
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
  note,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "positive" | "warning" | "negative";
  note?: string;
}) {
  const colour =
    tone === "positive"
      ? "text-green-700 dark:text-green-300"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-300"
        : tone === "negative"
          ? "text-rose-700 dark:text-rose-300"
          : "";
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-800">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</dd>
      {note ? <p className="text-xs text-rose-600 dark:text-rose-400">{note}</p> : null}
    </div>
  );
}
