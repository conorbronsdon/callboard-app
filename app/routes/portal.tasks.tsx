/**
 * Portal → Tasks: the onboarding checklist.
 *
 * Grouped the way the screenshots group them — **My Tasks** (person-scoped) and
 * **Submission Tasks** (scoped to one accepted talk) — because a speaker with
 * three accepted talks gets the submission-scoped tasks once per talk and needs
 * to see which is which.
 */
import { Link } from "react-router";

import { Card, EmptyState, ProgressMeter, StatusPill } from "~/components/portal-ui";
import {
  formatDueDate,
  groupTasks,
  isTaskDone,
  isTaskOverdue,
  relativeDue,
  sortTasksForSpeaker,
  taskCounts,
  type TaskSummary,
} from "~/lib/portal-progress";
import { loadTasks, portalContext } from "~/lib/portal/portal.server";
import type { Route } from "./+types/portal.tasks";

export function meta() {
  return [{ title: "Your tasks — callboard" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { actor, event } = await portalContext(request);
  return {
    now: Date.now(),
    eventName: event.name,
    timeZone: event.timezone,
    tasks: await loadTasks(actor.person.id, event.id),
  };
}

export default function PortalTasks({ loaderData }: Route.ComponentProps) {
  const { now, eventName, timeZone, tasks } = loaderData;
  const counts = taskCounts(tasks, now);
  const { myTasks, submissionTasks } = groupTasks(tasks);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {counts.total === 0
            ? `Nothing assigned for ${eventName} yet.`
            : `${counts.complete} of ${counts.total} complete${counts.overdue > 0 ? ` · ${counts.overdue} overdue` : ""}.`}
        </p>
      </header>

      {counts.total > 0 ? (
        <ProgressMeter percent={counts.percentComplete} label="Onboarding complete" />
      ) : null}

      {counts.total === 0 ? (
        <EmptyState title="No tasks yet">
          Once a submission is accepted, the programme team assigns onboarding tasks —
          confirming your slot, uploading a headshot, sending slides — and they land here.
        </EmptyState>
      ) : (
        <>
          <Card title={`Submission tasks (${submissionTasks.length})`}>
            <TaskList tasks={submissionTasks} now={now} timeZone={timeZone} emptyLabel="No submission tasks found." />
          </Card>
          <Card title={`My tasks (${myTasks.length})`} tone="plain">
            <TaskList tasks={myTasks} now={now} timeZone={timeZone} emptyLabel="No personal tasks found." />
          </Card>
        </>
      )}
    </div>
  );
}

function TaskList({
  tasks,
  now,
  timeZone,
  emptyLabel,
}: {
  tasks: TaskSummary[];
  now: number;
  timeZone: string;
  emptyLabel: string;
}) {
  if (tasks.length === 0) {
    return <p className="py-2 text-sm text-gray-500 dark:text-gray-400">{emptyLabel}</p>;
  }

  return (
    <ul className="divide-y divide-gray-200 dark:divide-gray-800">
      {sortTasksForSpeaker(tasks, now).map((task) => {
        const done = isTaskDone(task);
        const overdue = isTaskOverdue(task, now);
        return (
          <li key={task.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/portal/tasks/${task.id}`}
                  className={`text-sm font-medium hover:underline ${done ? "text-gray-500 line-through" : ""}`}
                >
                  <span aria-hidden="true" className="mr-2">
                    {done ? "☑" : "☐"}
                  </span>
                  {task.title}
                </Link>
                <p className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400">
                  {task.sessionTitle ? `${task.sessionTitle} · ` : ""}
                  {task.formId ? "Form to complete" : "Mark complete when done"}
                  {task.dueAt !== null
                    ? ` · due ${formatDueDate(task.dueAt, timeZone)} (${relativeDue(task.dueAt, now)})`
                    : " · no due date"}
                </p>
              </div>
              {done ? (
                <StatusPill tone="positive" glyph="✓">
                  {task.status === "waived" ? "Waived" : "Complete"}
                </StatusPill>
              ) : overdue ? (
                <StatusPill tone="negative" glyph="!">
                  Overdue
                </StatusPill>
              ) : (
                <StatusPill tone="warning" glyph="○">
                  To do
                </StatusPill>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
