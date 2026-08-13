import { isTaskDone, isTaskOverdue } from "~/lib/portal-progress";

export type AdminTaskKind = "manual" | "upload" | "form";
export type AdminTaskStatus = "pending" | "in_progress" | "complete" | "waived";

export interface AdminTaskRow {
  id: string;
  title: string;
  description: string | null;
  kind: AdminTaskKind;
  status: AdminTaskStatus;
  dueAt: number | null;
  completedAt: number | null;
  templateId: string | null;
  formId: string | null;
  personId: string;
  personName: string | null;
  personEmail: string;
  sessionId: string | null;
  sessionTitle: string | null;
}

export interface TaskFilters {
  status: "all" | "complete" | "incomplete" | "overdue";
  person: string;
  kind: "all" | AdminTaskKind;
  due: "all" | "overdue" | "soon" | "none";
  view: "task" | "speaker";
}

export interface TaskGroup {
  key: string;
  title: string;
  kind: AdminTaskKind;
  dueAt: number | null;
  rows: AdminTaskRow[];
}

export interface SpeakerGroup {
  personId: string;
  personName: string | null;
  personEmail: string;
  rows: AdminTaskRow[];
}

const STATUS_FILTERS = new Set<TaskFilters["status"]>([
  "all",
  "complete",
  "incomplete",
  "overdue",
]);
const KIND_FILTERS = new Set<TaskFilters["kind"]>(["all", "manual", "upload", "form"]);
const DUE_FILTERS = new Set<TaskFilters["due"]>(["all", "overdue", "soon", "none"]);
const VIEWS = new Set<TaskFilters["view"]>(["task", "speaker"]);
const SOON_MS = 7 * 86_400_000;

export function parseTaskFilters(params: URLSearchParams): TaskFilters {
  const status = params.get("status") as TaskFilters["status"] | null;
  const kind = params.get("kind") as TaskFilters["kind"] | null;
  const due = params.get("due") as TaskFilters["due"] | null;
  const view = params.get("view") as TaskFilters["view"] | null;
  const person = params.get("person")?.trim() || "all";

  return {
    status: status && STATUS_FILTERS.has(status) ? status : "all",
    person,
    kind: kind && KIND_FILTERS.has(kind) ? kind : "all",
    due: due && DUE_FILTERS.has(due) ? due : "all",
    view: view && VIEWS.has(view) ? view : "task",
  };
}

export function filterTasks(
  rows: AdminTaskRow[],
  filters: TaskFilters,
  now: number,
): AdminTaskRow[] {
  return rows.filter((row) => {
    if (filters.person !== "all" && row.personId !== filters.person) return false;
    if (filters.kind !== "all" && row.kind !== filters.kind) return false;

    if (filters.status === "complete" && !isTaskDone(row)) return false;
    if (filters.status === "incomplete" && isTaskDone(row)) return false;
    if (filters.status === "overdue" && !isTaskOverdue(row, now)) return false;

    if (filters.due === "none" && row.dueAt !== null) return false;
    if (filters.due === "overdue" && !isTaskOverdue(row, now)) return false;
    if (
      filters.due === "soon" &&
      (isTaskDone(row) || row.dueAt === null || row.dueAt < now || row.dueAt > now + SOON_MS)
    ) {
      return false;
    }
    return true;
  });
}

export function groupByTask(rows: AdminTaskRow[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const row of rows) {
    const key = row.templateId ?? `${row.title}|${row.dueAt}|${row.kind}`;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, title: row.title, kind: row.kind, dueAt: row.dueAt, rows: [row] });
  }
  return [...groups.values()];
}

export function groupBySpeaker(rows: AdminTaskRow[]): SpeakerGroup[] {
  const groups = new Map<string, SpeakerGroup>();
  for (const row of rows) {
    const group = groups.get(row.personId);
    if (group) group.rows.push(row);
    else {
      groups.set(row.personId, {
        personId: row.personId,
        personName: row.personName,
        personEmail: row.personEmail,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}

export function progressOf(rows: AdminTaskRow[]): {
  complete: number;
  total: number;
  percent: number;
} {
  const complete = rows.filter(isTaskDone).length;
  return {
    complete,
    total: rows.length,
    percent: rows.length === 0 ? 100 : Math.round((complete / rows.length) * 100),
  };
}
