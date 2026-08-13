/**
 * Pure logic for the 7-state abstract pipeline (DECISIONS.md #15).
 *
 * No I/O here — the queue-commit machinery in `commit.server.ts` and the
 * Abstracts route both consume these, so the rules are tested once and cannot
 * drift between the screen and the writer.
 */
// TYPE-only import on purpose: pulling the runtime `SESSION_STATUSES` array in
// drags all of app/db/schema.ts — and drizzle's sqlite-core with it — into the
// browser bundle for a screen that needs seven strings. `pipeline.test.ts`
// asserts STATUS_TABS still covers the enum exactly, so the tuple below cannot
// drift from the schema without going red.
import type { SessionStatus } from "~/db/schema";

export interface StatusTab {
  status: SessionStatus;
  /** Tab label from the product (screenshots p18_1): "Drafts", not "draft". */
  label: string;
  /** Tailwind classes for the status pill (p19_1's colour ladder). */
  tone: string;
}

/**
 * Tab ORDER is the product's, not the enum's: decisions read left-to-right from
 * accepted to declined, with the two speaker/system states parked at the end.
 */
export const STATUS_TABS: readonly StatusTab[] = [
  {
    status: "accepted",
    label: "Accepted",
    tone: "bg-green-700 text-white dark:bg-green-600",
  },
  {
    status: "accept_queue",
    label: "Accept Queue",
    tone: "bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100",
  },
  {
    status: "pending",
    label: "Pending",
    tone: "bg-yellow-100 text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100",
  },
  {
    status: "decline_queue",
    label: "Decline Queue",
    tone: "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-50",
  },
  {
    status: "declined",
    label: "Declined",
    tone: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  },
  {
    status: "withdrawn",
    label: "Withdrawn",
    tone: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  },
  { status: "draft", label: "Drafts", tone: "bg-gray-100 text-gray-600 dark:bg-gray-800" },
] as const;

export const DEFAULT_TAB: SessionStatus = "pending";

/**
 * The five statuses an admin may set by hand (screenshots p19_1). `withdrawn`
 * is speaker-initiated and `draft` is set by the form; offering them in the
 * review popover would let an admin fabricate a speaker's withdrawal.
 */
export const ADMIN_ASSIGNABLE_STATUSES = [
  "accepted",
  "accept_queue",
  "pending",
  "decline_queue",
  "declined",
] as const satisfies readonly SessionStatus[];

export type AdminAssignableStatus = (typeof ADMIN_ASSIGNABLE_STATUSES)[number];

const TAB_STATUSES: readonly string[] = STATUS_TABS.map((tab) => tab.status);

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && TAB_STATUSES.includes(value);
}

export function isAdminAssignable(value: unknown): value is AdminAssignableStatus {
  return (
    typeof value === "string" &&
    (ADMIN_ASSIGNABLE_STATUSES as readonly string[]).includes(value)
  );
}

/** Query-param -> tab, falling back rather than 500ing on a hand-typed URL. */
export function parseTab(value: string | null | undefined): SessionStatus {
  return isSessionStatus(value) ? value : DEFAULT_TAB;
}

export function tabFor(status: SessionStatus): StatusTab {
  return STATUS_TABS.find((tab) => tab.status === status) ?? STATUS_TABS[2];
}

export function statusLabel(status: SessionStatus): string {
  return tabFor(status).label;
}

/* ------------------------------------------------------- queue commit */

/** The commit is a pure partition first; the writer just executes the plan. */
export interface QueueCommitPlan {
  accept: string[];
  decline: string[];
  /** Ids handed in that the commit must NOT touch. */
  untouched: string[];
}

/**
 * Partition rows for "commit queues": staged accepts become accepted, staged
 * declines become declined, and EVERY other status is left alone — `pending`
 * most of all, because a commit that swept pending rows into a decision would
 * silently decide submissions nobody reviewed.
 */
export function planQueueCommit(
  rows: readonly { id: string; status: SessionStatus }[],
): QueueCommitPlan {
  const plan: QueueCommitPlan = { accept: [], decline: [], untouched: [] };
  for (const row of rows) {
    if (row.status === "accept_queue") plan.accept.push(row.id);
    else if (row.status === "decline_queue") plan.decline.push(row.id);
    else plan.untouched.push(row.id);
  }
  return plan;
}
