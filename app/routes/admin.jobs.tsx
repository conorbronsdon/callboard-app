import { Form, redirect, useNavigation } from "react-router";

import { requireAdmin } from "~/lib/auth/auth.server";
import { JOBS, runJob } from "~/lib/jobs/registry.server";
import type { Route } from "./+types/admin.jobs";

/**
 * Scheduled jobs, with a manual trigger.
 *
 * Cron triggers do not fire in local development, so `POST /admin/jobs/run` (the
 * resource route) stays the machine-readable way to execute one. This page posts
 * to ITSELF instead, and redirects back with a message — clicking a button in an
 * admin UI must not land the operator on a page of raw JSON.
 */
/** `task-reminders` → `Task reminders`. The registry key stays the API name. */
function humanName(name: string): string {
  const words = name.replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A cron expression is not a sentence an organiser should have to parse. Only
 * the two shapes this app actually schedules are translated; anything else
 * falls back to the expression itself rather than lying about it.
 */
export function humanSchedule(cron: string): string {
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (every) return `every ${every[1]} minutes`;

  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (daily) {
    const hour = String(daily[2]).padStart(2, "0");
    const minute = String(daily[1]).padStart(2, "0");
    return `daily at ${hour}:${minute} UTC`;
  }
  return `on schedule ${cron}`;
}

export function meta() {
  return [{ title: "Jobs — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const ranName = url.searchParams.get("ran");
  const ranOk = url.searchParams.get("ok");
  const message = url.searchParams.get("message");

  return {
    jobs: Object.values(JOBS).map((job) => ({
      name: job.name,
      title: humanName(job.name),
      description: job.description,
      schedule: job.cron ? humanSchedule(job.cron) : null,
    })),
    result:
      ranName && message ? { name: ranName, ok: ranOk === "1", message } : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const name = String(formData.get("name") ?? "");
  const result = await runJob(name, { now: new Date(), trigger: "manual" });

  const params = new URLSearchParams({
    ran: name,
    ok: result.ok ? "1" : "0",
    message: result.message,
  });
  return redirect(`/admin/jobs?${params.toString()}`);
}

export default function AdminJobs({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { result } = loaderData;

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold">Scheduled jobs</h2>
        <p className="mt-1 max-w-prose text-sm text-gray-600 dark:text-gray-300">
          Reminders and syncs run on their own schedule. Use <strong>Run now</strong> to
          trigger one immediately — useful right before a deadline, or to check a change
          without waiting for the next run.
        </p>
      </header>

      {result ? (
        <p
          data-testid="job-result"
          className={
            result.ok
              ? "rounded border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950"
              : "rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          }
        >
          {result.message}
        </p>
      ) : null}

      <ul className="divide-y divide-gray-200 dark:divide-gray-800">
        {loaderData.jobs.map((job) => (
          <li key={job.name} className="flex flex-wrap items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{job.title}</p>
              <p className="text-sm text-gray-500">{job.description}</p>
              {job.schedule ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">Runs {job.schedule}</p>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">Runs on demand only</p>
              )}
            </div>
            <Form method="post">
              <input type="hidden" name="name" value={job.name} />
              <button
                type="submit"
                disabled={navigation.state !== "idle"}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700"
              >
                Run now
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}
