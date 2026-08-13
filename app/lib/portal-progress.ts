/**
 * Portal home logic — pure, so the numbers on the judge-facing screen are
 * unit-testable without a database.
 *
 * Two things the walkthrough says the portal must lead with:
 *  1. **Acceptance status per submission, front and centre** ("a key part").
 *  2. **What the speaker has left to do**, as a count and as ONE next action.
 *
 * Sessionboard shows a task list and leaves the speaker to work out priority.
 * We compute the single next action, because "you have 4 tasks" is a status
 * bar, not a nudge. (Proposed DECISIONS entry — WS3 does not edit that file on
 * its branch; the orchestrator numbers it at merge.)
 */
import type { SessionStatus, TaskStatus } from "~/db/schema";

/* ------------------------------------------------------------ submissions */

export type StatusTone = "positive" | "warning" | "neutral" | "negative";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** Text glyph, so status is never conveyed by colour alone (a11y). */
  glyph: string;
  /** One line explaining what the state means for the speaker. */
  hint: string;
}

const STATUS_PRESENTATION: Record<SessionStatus, StatusPresentation> = {
  accepted: {
    label: "Accepted",
    tone: "positive",
    glyph: "✓",
    hint: "You're on the program. Finish your onboarding tasks.",
  },
  accept_queue: {
    label: "Under review",
    tone: "warning",
    glyph: "○",
    hint: "The program committee has not decided yet.",
  },
  pending: {
    label: "Under review",
    tone: "warning",
    glyph: "○",
    hint: "The program committee has not decided yet.",
  },
  decline_queue: {
    label: "Under review",
    tone: "warning",
    glyph: "○",
    hint: "The program committee has not decided yet.",
  },
  declined: {
    label: "Not accepted",
    tone: "negative",
    glyph: "×",
    hint: "This one didn't make the program this year.",
  },
  withdrawn: {
    label: "Withdrawn",
    tone: "neutral",
    glyph: "—",
    hint: "You withdrew this submission.",
  },
  draft: {
    label: "Draft",
    tone: "neutral",
    glyph: "◌",
    hint: "Not submitted yet — finish it before the form closes.",
  },
};

/**
 * How a submission status is shown to the SPEAKER.
 *
 * BOTH queues deliberately read as "Under review": the queues are an internal
 * staging mechanic (DECISIONS.md #15), and a queued row is organiser intent,
 * not a decision the organiser has committed to. Telling a speaker they are in
 * the decline queue before the committee commits would be a cruel leak; telling
 * them they are in the ACCEPT queue is the same leak wearing a smile — it makes
 * a promise the organiser can still walk back, and it is exactly the promise
 * they are most likely to act on. So the two queues are masked identically,
 * down to the glyph, and only a committed `accepted` / `declined` says anything.
 * Asserted by must-not-fire tests on both queues.
 */
export function statusPresentation(status: SessionStatus): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.pending;
}

/**
 * The statuses a SPEAKER is allowed to receive. Neither queue is a member.
 *
 * The mask above runs in the browser. `react-router.config.ts` sets `ssr: true`,
 * so whatever a portal loader returns is serialised into the document before
 * any component gets to hide it — masking in `statusPresentation` alone left
 * `"status":"accept_queue"` sitting in view-source. This type is the wire
 * contract that makes the leak a compile error rather than a code review.
 */
export type SpeakerVisibleStatus = Exclude<SessionStatus, "accept_queue" | "decline_queue">;

/**
 * Collapse a stored status onto what the speaker may know.
 *
 * Both queues project to `pending`, the ONE token whose presentation is already
 * byte-identical to theirs — same label, tone, glyph and hint — so the speaker's
 * screen does not move while the payload behind it stops telling the truth
 * about organiser intent. A committed `accepted` / `declined` passes through
 * untouched: masking the queue must never mask the decision.
 *
 * Organiser and reviewer surfaces do NOT go through here. They are entitled to
 * the raw queue and reading it is the entire point of the review pipeline.
 */
export function speakerVisibleStatus(status: SessionStatus): SpeakerVisibleStatus {
  return status === "accept_queue" || status === "decline_queue" ? "pending" : status;
}

export interface SubmissionSummary {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  format: string | null;
  /** True only for the participant who originally submitted the proposal. */
  isPrimary?: boolean;
}

/**
 * A submission summary that has been through `speakerVisibleStatus` — the only
 * shape a portal loader may return. Assigning a raw row here fails typecheck.
 */
export interface SpeakerSubmissionSummary extends Omit<SubmissionSummary, "status"> {
  status: SpeakerVisibleStatus;
}

export interface AcceptanceSummary {
  total: number;
  accepted: number;
  underReview: number;
  declined: number;
  /** The headline sentence at the top of the portal home page. */
  headline: string;
}

export function acceptanceSummary(submissions: SubmissionSummary[]): AcceptanceSummary {
  let accepted = 0;
  let underReview = 0;
  let declined = 0;

  for (const submission of submissions) {
    const tone = statusPresentation(submission.status).tone;
    if (tone === "positive") accepted += 1;
    else if (tone === "warning") underReview += 1;
    else if (tone === "negative") declined += 1;
  }

  let headline: string;
  if (submissions.length === 0) headline = "You have no submissions yet.";
  else if (accepted > 0 && underReview > 0) {
    headline = `${accepted} accepted, ${underReview} still under review.`;
  } else if (accepted > 0) {
    headline = accepted === 1 ? "Your talk was accepted." : `${accepted} of your talks were accepted.`;
  } else if (underReview > 0) {
    headline =
      underReview === 1
        ? "Your submission is under review."
        : `${underReview} submissions are under review.`;
  } else {
    headline = "No submissions are currently under consideration.";
  }

  return { total: submissions.length, accepted, underReview, declined, headline };
}

/* ------------------------------------------------------------------ tasks */

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  /** Epoch ms, or null for "no deadline". */
  dueAt: number | null;
  /** Set when the task belongs to a specific submission. */
  sessionId: string | null;
  sessionTitle?: string | null;
  /** Set when the task is completed by filling in a portal form. */
  formId: string | null;
}

export interface TaskCounts {
  total: number;
  open: number;
  complete: number;
  overdue: number;
  /** 0-100, rounded. 100 when there are no tasks at all. */
  percentComplete: number;
}

/** `complete` and `waived` both count as done — a waived task needs no action. */
export function isTaskDone(task: Pick<TaskSummary, "status">): boolean {
  return task.status === "complete" || task.status === "waived";
}

export function isTaskOverdue(task: TaskSummary, now: number): boolean {
  return !isTaskDone(task) && task.dueAt !== null && task.dueAt < now;
}

export function taskCounts(tasks: TaskSummary[], now: number): TaskCounts {
  const complete = tasks.filter(isTaskDone).length;
  const overdue = tasks.filter((task) => isTaskOverdue(task, now)).length;
  return {
    total: tasks.length,
    open: tasks.length - complete,
    complete,
    overdue,
    percentComplete: tasks.length === 0 ? 100 : Math.round((complete / tasks.length) * 100),
  };
}

/**
 * Split tasks the way the portal renders them: person-scoped ("My Tasks") and
 * submission-scoped ("Submission Tasks") — the split the screenshots show.
 */
export function groupTasks(tasks: TaskSummary[]): {
  myTasks: TaskSummary[];
  submissionTasks: TaskSummary[];
} {
  return {
    myTasks: tasks.filter((task) => task.sessionId === null),
    submissionTasks: tasks.filter((task) => task.sessionId !== null),
  };
}

/** Open first, then overdue-first, then by due date, then title. */
export function sortTasksForSpeaker(tasks: TaskSummary[], now: number): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const doneA = isTaskDone(a);
    const doneB = isTaskDone(b);
    if (doneA !== doneB) return doneA ? 1 : -1;

    const overdueA = isTaskOverdue(a, now);
    const overdueB = isTaskOverdue(b, now);
    if (overdueA !== overdueB) return overdueA ? -1 : 1;

    const dueA = a.dueAt ?? Number.POSITIVE_INFINITY;
    const dueB = b.dueAt ?? Number.POSITIVE_INFINITY;
    if (dueA !== dueB) return dueA - dueB;

    return a.title.localeCompare(b.title);
  });
}

/* ------------------------------------------------------------- the nudge */

export interface ProfileGaps {
  hasBio: boolean;
  hasHeadshot: boolean;
}

export interface NextAction {
  label: string;
  to: string;
  reason: string;
  urgent: boolean;
}

/**
 * The single thing the speaker should do next.
 *
 * Priority: overdue task → soonest-due open task → missing headshot → missing
 * bio → nothing. Profile gaps sit BELOW real tasks because a task carries a
 * deadline and the profile does not.
 */
export function nextAction(
  tasks: TaskSummary[],
  profile: ProfileGaps,
  now: number,
  timeZone: string,
): NextAction | null {
  const open = sortTasksForSpeaker(tasks.filter((task) => !isTaskDone(task)), now);

  const overdue = open.find((task) => isTaskOverdue(task, now));
  if (overdue) {
    return {
      label: overdue.title,
      to: `/portal/tasks/${overdue.id}`,
      reason: "Overdue",
      urgent: true,
    };
  }

  const next = open[0];
  if (next) {
    return {
      label: next.title,
      to: `/portal/tasks/${next.id}`,
      reason: next.dueAt === null ? "Outstanding task" : `Due ${formatDueDate(next.dueAt, timeZone)}`,
      urgent: false,
    };
  }

  if (!profile.hasHeadshot) {
    return {
      label: "Add a headshot",
      to: "/portal/profile",
      reason: "Your profile has no photo",
      urgent: false,
    };
  }
  if (!profile.hasBio) {
    return {
      label: "Write your bio",
      to: "/portal/profile",
      reason: "Your profile has no bio",
      urgent: false,
    };
  }
  return null;
}

/** Profile completeness for the progress meter on the portal home page. */
export function profileCompleteness(person: {
  fullName: string | null;
  bio: string | null;
  headshotKey: string | null;
  company: string | null;
  title: string | null;
  links: Record<string, string> | null;
}): { percent: number; missing: string[] } {
  const checks: [string, boolean][] = [
    ["name", Boolean(person.fullName?.trim())],
    ["bio", Boolean(person.bio?.trim())],
    ["headshot", Boolean(person.headshotKey)],
    ["company", Boolean(person.company?.trim())],
    ["job title", Boolean(person.title?.trim())],
    ["a link", Object.values(person.links ?? {}).some((value) => Boolean(value?.trim()))],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([label]) => label);
  return {
    percent: Math.round(((checks.length - missing.length) / checks.length) * 100),
    missing,
  };
}

/* ---------------------------------------------------------------- format */

/**
 * `Aug 18`, in the EVENT's timezone.
 *
 * ── Why the zone is a required argument ──────────────────────────────────────
 * This used to hardcode `timeZone: "UTC"`, which put every screen a day ahead of
 * the date the organizer typed for every organizer in the Americas (SPK-05 /
 * CNT-01). The write side was never wrong: `admin.tasks.tsx` anchors the typed
 * `YYYY-MM-DD` to 23:59 in the event zone via `zonedInputToEpoch`, so a Los
 * Angeles organizer's "Apr 1" is stored as `2027-04-02T06:59Z` — correct, and
 * read back in UTC it reads "Apr 2". Reminder EMAILS were right the whole time
 * (`formatDue(epoch, timeZone)`), so one task named two different days depending
 * on the surface.
 *
 * The parameter is required rather than defaulted so that a new render site is a
 * typecheck failure instead of a silent relapse to UTC.
 *
 * ── The old UTC hardcode's reason still holds ────────────────────────────────
 * It was there so SSR and hydration agree on the string, and they still do: the
 * zone travels in loader data from the event row, so server and client format
 * the same epoch in the same zone. What must never appear here is the BROWSER's
 * zone (`resolvedOptions().timeZone`) — that genuinely would differ across the
 * two renders, and it is also not the question being answered. A deadline
 * belongs to the conference, not to wherever the speaker happens to be sitting.
 */
export function formatDueDate(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(epochMs));
}

/** "in 3 days" / "2 days ago" / "today". */
export function relativeDue(epochMs: number, now: number): string {
  const dayMs = 86_400_000;
  const days = Math.round((epochMs - now) / dayMs);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
