/**
 * Reminder selection: must-fire and must-not-fire for every rule, and the
 * dedupe rule tested against real clock arithmetic rather than a call count.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMINDER_POLICY,
  formatTaskList,
  isOpenTaskStatus,
  selectReminders,
  type ReminderTask,
} from "./reminders";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0); // Sat 8 Aug 2026, the fixture clock
const DAY = 86_400_000;

let counter = 0;
function task(over: Partial<ReminderTask> = {}): ReminderTask {
  counter += 1;
  return {
    taskId: `task-${counter}`,
    personId: "person-1",
    email: "speaker@callboard.dev",
    name: "Sam Speaker",
    title: "Confirm your slot",
    status: "pending",
    dueAt: NOW + 2 * DAY,
    ...over,
  };
}

const select = (tasks: ReminderTask[], over: Partial<Parameters<typeof selectReminders>[0]> = {}) =>
  selectReminders({ now: NOW, tasks, ...over });

/* ------------------------------------------------------------ must-fire */

describe("MUST-FIRE", () => {
  it("a pending task due inside the window is reminded", () => {
    const batches = select([task({ dueAt: NOW + 2 * DAY })]);
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks).toHaveLength(1);
    expect(batches[0].email).toBe("speaker@callboard.dev");
    expect(batches[0].overdueCount).toBe(0);
  });

  it("an in_progress task counts as open", () => {
    expect(select([task({ status: "in_progress" })])).toHaveLength(1);
  });

  it("a PAST-DUE task is always reminded, however old", () => {
    const batches = select([task({ dueAt: NOW - 90 * DAY })]);
    expect(batches).toHaveLength(1);
    expect(batches[0].overdueCount).toBe(1);
  });

  it("one speaker's tasks arrive as ONE batch, soonest first", () => {
    const batches = select([
      task({ taskId: "t-late", title: "Submit your slides", dueAt: NOW + 5 * DAY }),
      task({ taskId: "t-early", title: "Confirm your slot", dueAt: NOW - DAY }),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks.map((t) => t.taskId)).toEqual(["t-early", "t-late"]);
    expect(batches[0].soonestDueAt).toBe(NOW - DAY);
  });

  it("the most urgent speaker is listed first", () => {
    const batches = select([
      task({ personId: "b", email: "b@x.test", dueAt: NOW + 5 * DAY }),
      task({ personId: "a", email: "a@x.test", dueAt: NOW - 2 * DAY }),
    ]);
    expect(batches.map((batch) => batch.personId)).toEqual(["a", "b"]);
  });
});

/* -------------------------------------------------------- must-not-fire */

describe("MUST-NOT-FIRE", () => {
  it("a completed task is never chased", () => {
    expect(select([task({ status: "complete" })])).toEqual([]);
  });

  it("a waived task is never chased", () => {
    expect(select([task({ status: "waived" })])).toEqual([]);
  });

  it("a task with no due date is never chased", () => {
    expect(select([task({ dueAt: null })])).toEqual([]);
  });

  it("a task due beyond the window is not chased YET", () => {
    expect(select([task({ dueAt: NOW + 8 * DAY })])).toEqual([]);
    // …and is picked up once it enters the window.
    expect(select([task({ dueAt: NOW + 8 * DAY })], { policy: { windowDays: 10 } })).toHaveLength(
      1,
    );
  });

  it("a task whose form has CLOSED is not chased — the speaker cannot act", () => {
    expect(select([task({ formClosesAt: NOW - DAY })])).toEqual([]);
  });

  it("a task whose form is still OPEN is chased", () => {
    expect(select([task({ formClosesAt: NOW + DAY })])).toHaveLength(1);
    expect(select([task({ formClosesAt: null })])).toHaveLength(1);
    expect(select([task({ formClosesAt: undefined })])).toHaveLength(1);
  });

  it("a speaker with no email address on file is skipped, not crashed on", () => {
    expect(select([task({ email: "" })])).toEqual([]);
  });

  it("nothing at all produces no batches", () => {
    expect(select([])).toEqual([]);
  });
});

/* ---------------------------------------------------------------- dedupe */

describe("dedupe — one reminder per task per cadence", () => {
  const open = task({ taskId: "t-1", dueAt: NOW + DAY });

  it("MUST-NOT-FIRE: a task reminded yesterday is not reminded again today", () => {
    const batches = select([open], { prior: [{ taskId: "t-1", sentAt: NOW - DAY }] });
    expect(batches).toEqual([]);
  });

  it("MUST-NOT-FIRE: still silent right up to the cadence boundary", () => {
    const justInside = NOW - (DEFAULT_REMINDER_POLICY.cadenceDays * DAY - 60_000);
    expect(select([open], { prior: [{ taskId: "t-1", sentAt: justInside }] })).toEqual([]);
  });

  it("MUST-FIRE: once the cadence has elapsed, it is reminded again", () => {
    const justOutside = NOW - (DEFAULT_REMINDER_POLICY.cadenceDays * DAY + 60_000);
    expect(select([open], { prior: [{ taskId: "t-1", sentAt: justOutside }] })).toHaveLength(1);
  });

  it("MUST-FIRE: a DIFFERENT task is not suppressed by its neighbour's reminder", () => {
    const batches = select([open, task({ taskId: "t-2", title: "Upload a headshot" })], {
      prior: [{ taskId: "t-1", sentAt: NOW - DAY }],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks.map((t) => t.taskId)).toEqual(["t-2"]);
  });

  it("uses the MOST RECENT prior reminder, not the first one it finds", () => {
    const batches = select([open], {
      prior: [
        { taskId: "t-1", sentAt: NOW - 30 * DAY },
        { taskId: "t-1", sentAt: NOW - DAY },
      ],
    });
    expect(batches).toEqual([]);
  });

  it("honours a custom cadence", () => {
    expect(
      select([open], {
        prior: [{ taskId: "t-1", sentAt: NOW - 5 * DAY }],
        policy: { cadenceDays: 14 },
      }),
    ).toEqual([]);
    expect(
      select([open], {
        prior: [{ taskId: "t-1", sentAt: NOW - 5 * DAY }],
        policy: { cadenceDays: 1 },
      }),
    ).toHaveLength(1);
  });
});

describe("formatTaskList", () => {
  it("marks overdue tasks and dates the rest in the event timezone", () => {
    const batches = select([
      task({ taskId: "a", title: "Confirm your slot", dueAt: NOW - 3 * DAY }),
      task({ taskId: "b", title: "Upload a headshot", dueAt: NOW + 2 * DAY }),
    ]);
    const text = formatTaskList(batches[0], NOW, "America/Los_Angeles");

    expect(text).toBe(
      [
        "- Confirm your slot (OVERDUE — was due Wed, Aug 5, 2026)",
        "- Upload a headshot (due Mon, Aug 10, 2026)",
      ].join("\n"),
    );
  });
});

describe("isOpenTaskStatus", () => {
  it("MUST-FIRE on open statuses, MUST-NOT-FIRE on finished ones", () => {
    expect(isOpenTaskStatus("pending")).toBe(true);
    expect(isOpenTaskStatus("in_progress")).toBe(true);
    expect(isOpenTaskStatus("complete")).toBe(false);
    expect(isOpenTaskStatus("waived")).toBe(false);
  });
});
