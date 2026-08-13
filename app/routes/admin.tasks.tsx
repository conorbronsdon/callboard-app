import { and, asc, eq } from "drizzle-orm";
import { Link, redirect } from "react-router";

import {
  Card,
  EmptyState,
  Notice,
  ProgressMeter,
  StatusPill,
  buttonClass,
  inputClass,
} from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { eventPeople, forms, people, sessions, tasks } from "~/db/schema";
import {
  filterTasks,
  groupBySpeaker,
  groupByTask,
  parseTaskFilters,
  progressOf,
  type AdminTaskRow,
  type SpeakerGroup,
  type TaskFilters,
  type TaskGroup,
} from "~/lib/admin-tasks";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import {
  formatDueDate,
  isTaskDone,
  isTaskOverdue,
  relativeDue,
} from "~/lib/portal-progress";
import {
  PORTAL_TYPE_TO_TARGET,
  type PortalFormSchema,
  type PortalFormSettings,
} from "~/lib/portal-form";
import { zonedInputToEpoch } from "~/lib/zoned-time";
import type { Route } from "./+types/admin.tasks";

const PAGE = "/admin/tasks";
const FIELD = inputClass;
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");
const SMALL = buttonClass("secondary", "sm");
const SMALL_DANGER = buttonClass("danger", "sm");

interface RosterPerson {
  id: string;
  fullName: string | null;
  email: string;
}

interface TasksData {
  now: number;
  event: { id: string; name: string; timezone: string } | null;
  roster: RosterPerson[];
  rows: AdminTaskRow[];
  total: number;
  filters: TaskFilters;
}

function error(message: string) {
  return { ok: false as const, error: message };
}

function requiredText(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

async function speakerRoster(eventId: string): Promise<RosterPerson[]> {
  return getDb()
    .select({ id: people.id, fullName: people.fullName, email: people.email })
    .from(eventPeople)
    .innerJoin(people, eq(people.id, eventPeople.personId))
    .where(and(eq(eventPeople.eventId, eventId), eq(eventPeople.eventRole, "speaker")))
    .orderBy(asc(people.fullName), asc(people.email));
}

export async function loader({ request }: Route.LoaderArgs): Promise<TasksData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const parsedFilters = parseTaskFilters(new URL(request.url).searchParams);
  const now = Date.now();
  if (!event) {
    return {
      now,
      event: null,
      roster: [],
      rows: [],
      total: 0,
      filters: { ...parsedFilters, person: "all" },
    };
  }

  const [roster, rawRows] = await Promise.all([
    speakerRoster(event.id),
    getDb()
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        kind: tasks.kind,
        status: tasks.status,
        dueAt: tasks.dueAt,
        completedAt: tasks.completedAt,
        templateId: tasks.templateId,
        formId: tasks.formId,
        personId: tasks.personId,
        personName: people.fullName,
        personEmail: people.email,
        sessionId: tasks.sessionId,
        sessionTitle: sessions.title,
      })
      .from(tasks)
      .innerJoin(people, eq(people.id, tasks.personId))
      .leftJoin(sessions, eq(sessions.id, tasks.sessionId))
      .where(eq(tasks.eventId, event.id))
      .orderBy(asc(tasks.dueAt), asc(tasks.title), asc(people.fullName))
      .limit(1000),
  ]);
  const rows: AdminTaskRow[] = rawRows.map((row) => ({
    ...row,
    dueAt: row.dueAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
  }));
  const filters = parsedFilters.person !== "all" && !roster.some((person) => person.id === parsedFilters.person)
    ? { ...parsedFilters, person: "all" }
    : parsedFilters;

  return {
    now,
    event: { id: event.id, name: event.name, timezone: event.timezone },
    roster,
    rows: filterTasks(rows, filters, now),
    total: rows.length,
    filters,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return error("Create an event before adding speaker tasks.");

  const db = getDb();
  const form = await request.formData();
  const intent = requiredText(form, "intent");
  const redirectTo = `${PAGE}${new URL(request.url).search}`;

  if (intent === "create") {
    const title = requiredText(form, "title");
    const instructionsValue = String(form.get("instructions") ?? "");
    const instructions = instructionsValue.trim() || null;
    const taskType = requiredText(form, "taskType");
    const dueOn = requiredText(form, "dueOn");
    const assignTo = requiredText(form, "assignTo");

    if (!title || title.length > 200) {
      return error("A title is required and must be 200 characters or fewer.");
    }
    if (instructionsValue.length > 5000) {
      return error("Instructions must be 5,000 characters or fewer.");
    }
    if (taskType !== "general" && taskType !== "file-request") {
      return error("Choose either a general task or a file request.");
    }
    if (assignTo !== "selected" && assignTo !== "all") {
      return error("Choose which speakers should receive this task.");
    }

    const dueAt = dueOn ? zonedInputToEpoch(`${dueOn}T23:59`, event.timezone) : null;
    if (dueOn && dueAt === null) return error("Enter the due date as YYYY-MM-DD.");

    const roster = await speakerRoster(event.id);
    const rosterIds = new Set(roster.map((person) => person.id));
    const submittedIds = assignTo === "all"
      ? roster.map((person) => person.id)
      : form.getAll("personIds").map(String);
    const personIds = [...new Set(submittedIds)];
    if (personIds.length === 0) return error("Assign this task to at least one speaker.");
    if (personIds.some((personId) => !rosterIds.has(personId))) {
      return error("Every assignee must belong to this event's speaker roster.");
    }

    const formId = taskType === "file-request" ? crypto.randomUUID() : null;
    const taskRows = personIds.map((personId) => ({
      id: crypto.randomUUID(),
      eventId: event.id,
      personId,
      title,
      description: instructions,
      kind: taskType === "file-request" ? "upload" as const : "manual" as const,
      formId,
      status: "pending" as const,
      dueAt: dueAt === null ? null : new Date(dueAt),
    }));

    if (taskType === "file-request") {
      const schema: PortalFormSchema = {
        sectionTitle: title,
        ...(instructions ? { description: instructions } : {}),
        questions: [{
          key: "deliverable",
          label: "Upload your file",
          type: "file",
          required: true,
          filePurpose: "document",
        }],
      };
      const settings: PortalFormSettings = {
        surface: "portal",
        type: "submissions",
        requireLogin: true,
      };
      await db.batch([
        db.insert(forms).values({
          id: formId!,
          eventId: event.id,
          surface: "portal",
          status: "open",
          target: PORTAL_TYPE_TO_TARGET.submissions,
          name: title,
          schema: schema as unknown as Record<string, unknown>,
          settings: settings as unknown as Record<string, unknown>,
        }),
        db.insert(tasks).values(taskRows),
      ]);
    } else {
      await db.batch([db.insert(tasks).values(taskRows)]);
    }
    return redirect(redirectTo);
  }

  const taskId = requiredText(form, "taskId");
  if (!taskId) return error("Choose a task row.");
  const taskWhere = and(eq(tasks.id, taskId), eq(tasks.eventId, event.id));

  if (intent === "complete") {
    await db
      .update(tasks)
      .set({ status: "complete", completedAt: new Date(), completedById: admin.id })
      .where(taskWhere);
    return redirect(redirectTo);
  }
  if (intent === "reopen") {
    await db
      .update(tasks)
      .set({ status: "pending", completedAt: null, completedById: null })
      .where(taskWhere);
    return redirect(redirectTo);
  }
  if (intent === "delete") {
    await db.delete(tasks).where(taskWhere);
    return redirect(redirectTo);
  }
  return error(`Unknown intent "${intent}".`);
}

function filterHref(filters: TaskFilters, view: TaskFilters["view"]): string {
  const params = new URLSearchParams({
    view,
    status: filters.status,
    person: filters.person,
    kind: filters.kind,
    due: filters.due,
  });
  return `${PAGE}?${params}`;
}

function displayName(row: Pick<AdminTaskRow, "personName" | "personEmail">): string {
  return row.personName?.trim() || row.personEmail;
}

function taskStatus(row: AdminTaskRow, now: number) {
  if (row.status === "waived") return <StatusPill tone="neutral" glyph="—">Waived</StatusPill>;
  if (row.status === "complete") return <StatusPill tone="positive" glyph="✓">Complete</StatusPill>;
  if (isTaskOverdue(row, now)) return <StatusPill tone="negative" glyph="!">Overdue</StatusPill>;
  if (row.status === "in_progress") return <StatusPill tone="warning" glyph="○">In progress</StatusPill>;
  return <StatusPill tone="warning" glyph="○">Pending</StatusPill>;
}

function RowActions({ row }: { row: AdminTaskRow }) {
  const name = displayName(row);
  return (
    <div className="flex flex-wrap gap-2">
      {isTaskDone(row) ? (
        <form method="post">
          <input type="hidden" name="intent" value="reopen" />
          <input type="hidden" name="taskId" value={row.id} />
          <button className={SMALL} type="submit" aria-label={`Reopen ${row.title} for ${name}`}>Reopen</button>
        </form>
      ) : (
        <form method="post">
          <input type="hidden" name="intent" value="complete" />
          <input type="hidden" name="taskId" value={row.id} />
          <button className={SMALL} type="submit" aria-label={`Mark ${row.title} complete for ${name}`}>Mark complete</button>
        </form>
      )}
      <form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="taskId" value={row.id} />
        <button className={SMALL_DANGER} type="submit" aria-label={`Delete ${row.title} for ${name}`}>Delete</button>
      </form>
    </div>
  );
}

function DueDate({ row, now, timeZone }: { row: Pick<AdminTaskRow, "dueAt">; now: number; timeZone: string }) {
  return row.dueAt === null ? <span>No due date</span> : (
    <span>{formatDueDate(row.dueAt, timeZone)} <span className="text-gray-500 dark:text-gray-400">({relativeDue(row.dueAt, now)})</span></span>
  );
}

function TaskView({ groups, allRows, now, timeZone }: { groups: TaskGroup[]; allRows: AdminTaskRow[]; now: number; timeZone: string }) {
  const speakerProgress = new Map(groupBySpeaker(allRows).map((group) => [group.personId, progressOf(group.rows)]));
  return (
    <section data-task-view="task" className="space-y-4">
      <h2 className="text-lg font-semibold">Progress by task</h2>
      {groups.map((group) => {
        const progress = progressOf(group.rows);
        return (
          <div key={group.key} data-task-group={group.key}>
            <Card
              title={group.title}
              action={<span>{group.kind === "upload" ? "File request" : group.kind === "form" ? "Form" : "General"}</span>}
            >
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)] sm:items-end">
                  <p className="text-sm"><span className="font-medium">Due:</span> <DueDate row={{ dueAt: group.dueAt }} now={now} timeZone={timeZone} /></p>
                  <ProgressMeter percent={progress.percent} label={`${progress.complete} of ${progress.total} complete`} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-4xl text-left text-sm">
                    <thead className="border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase dark:border-gray-800 dark:text-gray-400">
                      <tr><th className="px-3 py-2">Speaker</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Completed</th><th className="px-3 py-2">Speaker progress</th><th className="px-3 py-2">Actions</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {group.rows.map((row) => {
                        const personal = speakerProgress.get(row.personId)!;
                        return (
                          <tr key={row.id} data-task-row={row.id} data-task-status={row.status} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                            <td className="px-3 py-3 font-medium">{displayName(row)}</td>
                            <td className="px-3 py-3 text-gray-600 dark:text-gray-400">{row.personEmail}</td>
                            <td className="px-3 py-3">{taskStatus(row, now)}</td>
                            <td className="px-3 py-3 whitespace-nowrap">{row.completedAt === null ? "—" : formatDueDate(row.completedAt, timeZone)}</td>
                            <td className="px-3 py-3 whitespace-nowrap">{personal.complete} of {personal.total} complete</td>
                            <td className="px-3 py-3"><RowActions row={row} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </section>
  );
}

function SpeakerView({ groups, now, timeZone }: { groups: SpeakerGroup[]; now: number; timeZone: string }) {
  return (
    <section data-task-view="speaker" className="space-y-4">
      <h2 className="text-lg font-semibold">Progress by speaker</h2>
      {groups.map((group) => {
        const progress = progressOf(group.rows);
        return (
          <div key={group.personId} data-speaker-group={group.personId}>
            <Card title={group.personName?.trim() || group.personEmail} action={<span>{progress.complete} of {progress.total} complete</span>}>
              <div className="space-y-4">
                <ProgressMeter percent={progress.percent} label={`${progress.complete} of ${progress.total} complete`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-3xl text-left text-sm">
                    <thead className="border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase dark:border-gray-800 dark:text-gray-400">
                      <tr><th className="px-3 py-2">Task</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Actions</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {group.rows.map((row) => (
                        <tr key={row.id} data-task-row={row.id} data-task-status={row.status} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                          <td className="px-3 py-3 font-medium">{row.title}</td>
                          <td className="px-3 py-3 whitespace-nowrap"><DueDate row={row} now={now} timeZone={timeZone} /></td>
                          <td className="px-3 py-3">{taskStatus(row, now)}</td>
                          <td className="px-3 py-3"><RowActions row={row} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </section>
  );
}

export function TasksView({ event, roster, rows, total, filters, now, actionError }: TasksData & { actionError?: string }) {
  if (!event) {
    return (
      <section data-testid="admin-tasks" data-task-count="0" className="rounded-xl border border-gray-200 p-6 dark:border-gray-800">
        <h1 className="text-xl font-semibold">Speaker tasks</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Create an event in Settings before adding speaker tasks.</p>
      </section>
    );
  }

  return (
    <div data-testid="admin-tasks" data-task-count={rows.length} className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Speaker tasks</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Create assignments and track every speaker-task pair for {event.name}.</p>
        </div>
        {/*
         * CNT-08: pre-selects the "Has outstanding tasks" audience and the
         * Task reminder template on the compose screen — the organizer still
         * reviews and clicks Send there, which is also where the send
         * confirmation ("Sent N of M") renders.
         */}
        <Link className={GHOST} to="/admin/comms?audience=outstanding_tasks&template=task_reminder">
          Send reminder to speakers with outstanding tasks
        </Link>
      </header>

      {actionError ? <Notice tone="error">{actionError}</Notice> : null}

      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="font-semibold">Create a task</h2>
        <form method="post" data-testid="task-create-form" className="mt-4 grid gap-4">
          <input type="hidden" name="intent" value="create" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">Title<input className={FIELD} name="title" required maxLength={200} /></label>
            <label className="grid gap-1 text-sm">Due date<input className={FIELD} name="dueOn" type="date" /></label>
          </div>
          <label className="grid gap-1 text-sm">Instructions<textarea className={FIELD} name="instructions" rows={3} maxLength={5000} /></label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">Task type<select className={FIELD} name="taskType" defaultValue="general"><option value="general">General</option><option value="file-request">File request</option></select></label>
            <label className="grid gap-1 text-sm">Assignment<select className={FIELD} name="assignTo" defaultValue="selected"><option value="selected">Selected speakers</option><option value="all">All speakers</option></select></label>
          </div>
          <label className="grid gap-1 text-sm">Speakers<select className={FIELD} name="personIds" multiple size={Math.min(Math.max(roster.length, 2), 6)}>{roster.map((person) => <option key={person.id} value={person.id}>{person.fullName?.trim() || person.email} — {person.email}</option>)}</select></label>
          {roster.length === 0 ? <p className="text-sm text-amber-700 dark:text-amber-300">Add speakers to this event before assigning a task.</p> : null}
          <div><button className={BUTTON} type="submit">Create tasks</button></div>
        </form>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">Showing {rows.length} of {total} speaker-task pairs.</p>
          <nav aria-label="Task dashboard view" className="flex gap-2">
            <Link className={filters.view === "task" ? BUTTON : GHOST} to={filterHref(filters, "task")}>By task</Link>
            <Link className={filters.view === "speaker" ? BUTTON : GHOST} to={filterHref(filters, "speaker")}>By speaker</Link>
          </nav>
        </div>
        <form method="get" data-testid="task-filters" className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-gray-800 dark:bg-gray-900">
          <input type="hidden" name="view" value={filters.view} />
          <label htmlFor="task-filter-status" className="grid gap-1 text-sm">Completion<select id="task-filter-status" className={FIELD} name="status" defaultValue={filters.status}><option value="all">All statuses</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option><option value="overdue">Overdue</option></select></label>
          <label htmlFor="task-filter-person" className="grid gap-1 text-sm">Speaker<select id="task-filter-person" className={FIELD} name="person" defaultValue={filters.person}><option value="all">All speakers</option>{roster.map((person) => <option key={person.id} value={person.id}>{person.fullName?.trim() || person.email}</option>)}</select></label>
          <label htmlFor="task-filter-kind" className="grid gap-1 text-sm">Type<select id="task-filter-kind" className={FIELD} name="kind" defaultValue={filters.kind}><option value="all">All types</option><option value="manual">General</option><option value="upload">File request</option><option value="form">Form</option></select></label>
          <label htmlFor="task-filter-due" className="grid gap-1 text-sm">Due<select id="task-filter-due" className={FIELD} name="due" defaultValue={filters.due}><option value="all">Any due date</option><option value="overdue">Overdue</option><option value="soon">Due in 7 days</option><option value="none">No due date</option></select></label>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4"><button className={BUTTON} type="submit">Apply task filters</button><Link className={GHOST} to={`${PAGE}?view=${filters.view}`}>Clear task filters</Link></div>
        </form>
      </section>

      {total === 0 ? (
        <div data-testid="admin-tasks-empty"><EmptyState title="No tasks have been created for this event yet.">Create the first assignment above; each selected speaker gets their own trackable task row.</EmptyState></div>
      ) : rows.length === 0 ? (
        <div data-testid="admin-tasks-no-match"><EmptyState title="No tasks match these filters.">Clear the filters to return to the full deliverables dashboard.</EmptyState></div>
      ) : filters.view === "speaker" ? (
        <SpeakerView groups={groupBySpeaker(rows)} now={now} timeZone={event.timezone} />
      ) : (
        <TaskView groups={groupByTask(rows)} allRows={rows} now={now} timeZone={event.timezone} />
      )}
    </div>
  );
}

export default function AdminTasks({ loaderData, actionData }: Route.ComponentProps) {
  return <TasksView {...loaderData} actionError={actionData?.error} />;
}
