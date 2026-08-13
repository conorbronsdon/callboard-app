/**
 * Which speakers get a task reminder, and which deliberately do not. PURE.
 *
 * The dedupe rule is the one that matters. A cron job that re-reads the same
 * open tasks every night will happily email a speaker the same nag every night
 * until they act — which is how a product teaches people to filter it. So:
 *
 *   ONE reminder per TASK per CADENCE.
 *
 * The unit is the task, not the email: a speaker with three open tasks gets one
 * message covering all three, and each of those three tasks is stamped in the
 * comm_log row's `meta.taskIds`. A fourth task falling due tomorrow can then
 * still produce a message tomorrow without re-nagging the other three — the
 * digest only names tasks that are actually due for a reminder.
 *
 * Gating on the form close date (PLAN §4 WS5, the brief's red "kinda impt") is the
 * other half: chasing someone to fill in a form that has closed is worse than
 * silence, because they cannot act on it.
 */

export interface ReminderPolicy {
  /** Remind about tasks due within this many days. Past-due always qualifies. */
  windowDays: number;
  /** Minimum days between two reminders about the SAME task. */
  cadenceDays: number;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  windowDays: 7,
  cadenceDays: 3,
};

export interface ReminderTask {
  taskId: string;
  personId: string;
  email: string;
  name: string | null;
  title: string;
  status: string;
  /** Epoch ms. A task with no due date is never chased. */
  dueAt: number | null;
  /** Close date of the form this task embeds, when it embeds one. Epoch ms. */
  formClosesAt?: number | null;
}

export interface ReminderBatch {
  personId: string;
  email: string;
  name: string | null;
  tasks: ReminderTask[];
  /** Soonest due date across the batch — the `{{task.due}}` merge field. */
  soonestDueAt: number;
  overdueCount: number;
}

export interface PriorReminder {
  taskId: string;
  /** Epoch ms of the previous reminder that covered this task. */
  sentAt: number;
}

const DAY_MS = 86_400_000;

/** Statuses that still need doing. `complete` and `waived` are finished. */
const OPEN_STATUSES = new Set(["pending", "in_progress"]);

export function isOpenTaskStatus(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * The batches to send. Empty array is a correct, common answer — a job run
 * that emails nobody is the steady state once everyone is caught up.
 */
export function selectReminders(args: {
  now: number;
  tasks: readonly ReminderTask[];
  prior?: readonly PriorReminder[];
  policy?: Partial<ReminderPolicy>;
}): ReminderBatch[] {
  const policy = { ...DEFAULT_REMINDER_POLICY, ...(args.policy ?? {}) };
  const windowMs = policy.windowDays * DAY_MS;
  const cadenceMs = policy.cadenceDays * DAY_MS;

  /** Most recent reminder per task. */
  const lastReminded = new Map<string, number>();
  for (const entry of args.prior ?? []) {
    const current = lastReminded.get(entry.taskId);
    if (current === undefined || entry.sentAt > current) {
      lastReminded.set(entry.taskId, entry.sentAt);
    }
  }

  const due = args.tasks.filter((task) => {
    if (!task.email) return false;
    if (!isOpenTaskStatus(task.status)) return false;
    if (task.dueAt === null || !Number.isFinite(task.dueAt)) return false;
    // Due soon or already past due.
    if (task.dueAt > args.now + windowMs) return false;
    // The form behind this task has closed — nothing the speaker can do.
    if (
      task.formClosesAt !== null &&
      task.formClosesAt !== undefined &&
      task.formClosesAt <= args.now
    ) {
      return false;
    }
    const last = lastReminded.get(task.taskId);
    if (last !== undefined && args.now - last < cadenceMs) return false;
    return true;
  });

  const byPerson = new Map<string, ReminderTask[]>();
  for (const task of due) {
    const list = byPerson.get(task.personId);
    if (list) list.push(task);
    else byPerson.set(task.personId, [task]);
  }

  const batches: ReminderBatch[] = [];
  for (const [personId, tasks] of byPerson) {
    const ordered = [...tasks].sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    batches.push({
      personId,
      email: ordered[0].email,
      name: ordered[0].name,
      tasks: ordered,
      soonestDueAt: ordered[0].dueAt as number,
      overdueCount: ordered.filter((task) => (task.dueAt as number) < args.now).length,
    });
  }

  // Most urgent speaker first — the run log reads as a priority list.
  return batches.sort((a, b) => a.soonestDueAt - b.soonestDueAt);
}

/** "- Confirm your slot (overdue — was due Wed Aug 5)" */
export function formatTaskLine(task: ReminderTask, now: number, timeZone: string): string {
  const due = task.dueAt as number;
  const label = formatDue(due, timeZone);
  return due < now
    ? `- ${task.title} (OVERDUE — was due ${label})`
    : `- ${task.title} (due ${label})`;
}

export function formatDue(epoch: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(epoch));
}

export function formatTaskList(
  batch: ReminderBatch,
  now: number,
  timeZone: string,
): string {
  return batch.tasks.map((task) => formatTaskLine(task, now, timeZone)).join("\n");
}
