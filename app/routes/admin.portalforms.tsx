/**
 * Admin → Portal forms (list). "Create forms that can be assigned to your
 * portals to collect information."
 *
 * Portal forms are isolated by the `forms.surface` column. The JSON setting is
 * retained for the portal form definition, but it is not an authorization or
 * routing boundary.
 */
import { Form, Link, redirect } from "react-router";
import { and, asc, eq } from "drizzle-orm";

import { EmptyState, buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { forms, tasks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import {
  PORTAL_TYPE_TO_TARGET,
  readPortalSchema,
  readPortalSettings,
} from "~/lib/portal-form";
import type { Route } from "./+types/admin.portalforms";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();

  const [rows, taskRows] = await Promise.all([
    db
      .select()
      .from(forms)
      .where(and(eq(forms.eventId, event.id), eq(forms.surface, "portal")))
      .orderBy(asc(forms.createdAt))
      .limit(200),
    db.select({ formId: tasks.formId }).from(tasks).where(eq(tasks.eventId, event.id)).limit(1000),
  ]);

  return {
    forms: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        type: readPortalSettings(row.settings).type,
        questionCount: readPortalSchema(row.schema).questions.length,
        usedByTasks: taskRows.filter((task) => task.formId === row.id).length,
      })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);

  const body = await request.formData();
  if (String(body.get("intent")) !== "create") {
    throw new Response("Unknown action.", { status: 400 });
  }

  const [created] = await getDb()
    .insert(forms)
    .values({
      eventId: event.id,
      surface: "portal",
      name: "Untitled portal form",
      target: PORTAL_TYPE_TO_TARGET.submissions,
      status: "draft",
      welcomeTitle: "",
      schema: { sectionTitle: "Update your information", questions: [] },
      settings: { surface: "portal", type: "submissions", requireLogin: true },
    })
    .returning();

  return redirect(`/admin/portal-forms/${created.id}`);
}

export default function AdminPortalForms({ loaderData }: Route.ComponentProps) {
  const { forms: rows } = loaderData;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Portal forms</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Forms speakers fill out from inside a task. Three steps, not the seven-step CFP
            wizard — these collect a handful of answers, not a submission.
          </p>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <button type="submit" className={buttonClass()}>
            + Add form
          </button>
        </Form>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="No forms yet">
          Create a form to collect information from speakers — shirt sizes, travel dates, a
          slide upload.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <Link
                  to={`/admin/portal-forms/${row.id}`}
                  className="font-medium hover:underline"
                >
                  {row.name}
                </Link>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {row.type} · {row.questionCount} question{row.questionCount === 1 ? "" : "s"} ·
                  used by {row.usedByTasks} task{row.usedByTasks === 1 ? "" : "s"}
                </p>
              </div>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium dark:bg-gray-800">
                {row.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
