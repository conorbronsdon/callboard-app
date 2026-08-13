import { describe, expect, it } from "vitest";

import {
  acceptanceSummary,
  formatDueDate,
  groupTasks,
  isTaskDone,
  isTaskOverdue,
  nextAction,
  profileCompleteness,
  relativeDue,
  sortTasksForSpeaker,
  statusPresentation,
  taskCounts,
  type TaskSummary,
} from "./portal-progress";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const DAY = 86_400_000;

const task = (over: Partial<TaskSummary> & { id: string; title: string }): TaskSummary => ({
  status: "pending",
  dueAt: null,
  sessionId: null,
  formId: null,
  ...over,
});

describe("statusPresentation", () => {
  it("labels accepted and declined for the speaker", () => {
    expect(statusPresentation("accepted").label).toBe("Accepted");
    expect(statusPresentation("accepted").tone).toBe("positive");
    expect(statusPresentation("declined").tone).toBe("negative");
  });

  /* must-not-fire: the internal queue state must not leak to the speaker */
  it("does NOT tell a speaker they are in the decline queue", () => {
    const shown = statusPresentation("decline_queue");
    expect(shown.label).toBe("Under review");
    expect(shown.label.toLowerCase()).not.toContain("decline");
    expect(shown.hint.toLowerCase()).not.toContain("decline");
  });

  /* must-not-fire: the accept queue is organiser intent, not a decision. Until
     the organiser commits the queue it must read exactly like the decline queue
     — same label, same tone, same glyph, same hint (Conor, 2026-08-11). */
  it("does NOT tell a speaker they are in the accept queue", () => {
    const shown = statusPresentation("accept_queue");
    expect(shown.label).toBe("Under review");
    expect(shown.tone).toBe("warning");
    expect(shown.label.toLowerCase()).not.toContain("accept");
    expect(shown.hint.toLowerCase()).not.toContain("accept");
    expect(shown.hint.toLowerCase()).not.toContain("select");
  });

  /* must-fire: masked means indistinguishable, glyph included — a speaker must
     not be able to tell the two queues apart from the pill. */
  it("masks a queued accept identically to a queued decline", () => {
    expect(statusPresentation("accept_queue")).toEqual(statusPresentation("decline_queue"));
  });

  /* must-still-fire: masking the QUEUE must not mask the committed decision */
  it("still shows a committed accept as good news", () => {
    expect(statusPresentation("accepted").label).toBe("Accepted");
    expect(statusPresentation("accepted").tone).toBe("positive");
  });

  it("gives every status a non-colour glyph", () => {
    for (const status of ["accepted", "pending", "declined", "withdrawn", "draft"] as const) {
      expect(statusPresentation(status).glyph.length).toBeGreaterThan(0);
    }
  });
});

describe("acceptanceSummary", () => {
  it("counts by tone, not by raw status", () => {
    const summary = acceptanceSummary([
      { id: "1", friendlyId: "ABS-1", title: "a", status: "accepted", format: "Talk" },
      { id: "2", friendlyId: "ABS-2", title: "b", status: "accept_queue", format: "Talk" },
      { id: "3", friendlyId: "ABS-3", title: "c", status: "pending", format: null },
      { id: "4", friendlyId: "ABS-4", title: "d", status: "decline_queue", format: null },
      { id: "5", friendlyId: "ABS-5", title: "e", status: "declined", format: null },
    ]);
    expect(summary.total).toBe(5);
    // A staged accept is NOT an acceptance: only the committed row counts.
    expect(summary.accepted).toBe(1);
    expect(summary.underReview).toBe(3);
    expect(summary.declined).toBe(1);
    expect(summary.headline).toBe("1 accepted, 3 still under review.");
  });

  /* must-fire + must-still-fire, side by side: committing the queue is what
     moves a submission out of the accepted tile's blind spot. */
  it("excludes a queued accept from the accepted count but keeps a committed one", () => {
    expect(
      acceptanceSummary([
        { id: "1", friendlyId: null, title: "a", status: "accept_queue", format: null },
      ]),
    ).toMatchObject({ accepted: 0, underReview: 1, declined: 0 });
    expect(
      acceptanceSummary([
        { id: "1", friendlyId: null, title: "a", status: "accepted", format: null },
      ]),
    ).toMatchObject({ accepted: 1, underReview: 0, declined: 0 });
  });

  /* must-still-fire: the decline queue's existing masking is untouched */
  it("still counts a queued decline as under review, not declined", () => {
    expect(
      acceptanceSummary([
        { id: "1", friendlyId: null, title: "a", status: "decline_queue", format: null },
      ]),
    ).toMatchObject({ accepted: 0, underReview: 1, declined: 0 });
    expect(
      acceptanceSummary([
        { id: "1", friendlyId: null, title: "a", status: "declined", format: null },
      ]),
    ).toMatchObject({ accepted: 0, underReview: 0, declined: 1 });
  });

  it("handles the zero state", () => {
    const summary = acceptanceSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.headline).toBe("You have no submissions yet.");
  });

  it("uses the singular headline for one accepted talk", () => {
    expect(
      acceptanceSummary([
        { id: "1", friendlyId: null, title: "a", status: "accepted", format: null },
      ]).headline,
    ).toBe("Your talk was accepted.");
  });
});

describe("taskCounts", () => {
  it("counts open, complete and overdue", () => {
    const counts = taskCounts(
      [
        task({ id: "1", title: "done", status: "complete" }),
        task({ id: "2", title: "waived", status: "waived" }),
        task({ id: "3", title: "late", dueAt: NOW - DAY }),
        task({ id: "4", title: "soon", dueAt: NOW + DAY }),
      ],
      NOW,
    );
    expect(counts).toEqual({ total: 4, open: 2, complete: 2, overdue: 1, percentComplete: 50 });
  });

  it("reports 100% for a speaker with no tasks (not 0% or NaN)", () => {
    expect(taskCounts([], NOW)).toEqual({
      total: 0,
      open: 0,
      complete: 0,
      overdue: 0,
      percentComplete: 100,
    });
  });

  /* must-not-fire: a completed task past its date is NOT overdue */
  it("does NOT mark a completed past-due task as overdue", () => {
    const counts = taskCounts(
      [task({ id: "1", title: "done late", status: "complete", dueAt: NOW - 10 * DAY })],
      NOW,
    );
    expect(counts.overdue).toBe(0);
  });

  /* must-not-fire: no due date means never overdue */
  it("does NOT mark an undated open task as overdue", () => {
    expect(isTaskOverdue(task({ id: "1", title: "x", dueAt: null }), NOW)).toBe(false);
  });

  it("treats waived as done", () => {
    expect(isTaskDone({ status: "waived" })).toBe(true);
    expect(isTaskDone({ status: "in_progress" })).toBe(false);
  });
});

describe("groupTasks", () => {
  it("splits person-scoped from submission-scoped tasks", () => {
    const grouped = groupTasks([
      task({ id: "1", title: "bio" }),
      task({ id: "2", title: "slides", sessionId: "sess-1" }),
    ]);
    expect(grouped.myTasks.map((t) => t.id)).toEqual(["1"]);
    expect(grouped.submissionTasks.map((t) => t.id)).toEqual(["2"]);
  });

  it("returns two empty buckets for no tasks", () => {
    expect(groupTasks([])).toEqual({ myTasks: [], submissionTasks: [] });
  });
});

describe("sortTasksForSpeaker", () => {
  it("puts overdue first, then soonest due, then done last", () => {
    const sorted = sortTasksForSpeaker(
      [
        task({ id: "done", title: "done", status: "complete", dueAt: NOW - 5 * DAY }),
        task({ id: "later", title: "later", dueAt: NOW + 10 * DAY }),
        task({ id: "overdue", title: "overdue", dueAt: NOW - DAY }),
        task({ id: "soon", title: "soon", dueAt: NOW + DAY }),
        task({ id: "undated", title: "undated" }),
      ],
      NOW,
    );
    expect(sorted.map((t) => t.id)).toEqual(["overdue", "soon", "later", "undated", "done"]);
  });

  it("does not mutate its input", () => {
    const input = [task({ id: "b", title: "b" }), task({ id: "a", title: "a" })];
    sortTasksForSpeaker(input, NOW);
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("nextAction", () => {
  const complete = { hasBio: true, hasHeadshot: true };
  /* A negative-offset zone on purpose: the `Due ...` reason string is built by
     `formatDueDate`, so a UTC relapse would move it (SPK-05 / CNT-01). */
  const TZ = "America/Los_Angeles";

  it("picks the overdue task first and marks it urgent", () => {
    const action = nextAction(
      [
        task({ id: "soon", title: "Soon", dueAt: NOW + DAY }),
        task({ id: "late", title: "Upload slides", dueAt: NOW - 2 * DAY }),
      ],
      complete,
      NOW,
      TZ,
    );
    expect(action).toEqual({
      label: "Upload slides",
      to: "/portal/tasks/late",
      reason: "Overdue",
      urgent: true,
    });
  });

  it("otherwise picks the soonest-due open task", () => {
    const action = nextAction(
      [
        task({ id: "later", title: "Later", dueAt: NOW + 30 * DAY }),
        task({ id: "soon", title: "Confirm your slot", dueAt: NOW + DAY }),
      ],
      complete,
      NOW,
      TZ,
    );
    expect(action?.to).toBe("/portal/tasks/soon");
    expect(action?.urgent).toBe(false);
    expect(action?.reason).toContain("Due");
  });

  /* must-not-fire: completed tasks are never nudged */
  it("does NOT nudge a completed task", () => {
    const action = nextAction(
      [task({ id: "done", title: "Done", status: "complete", dueAt: NOW - DAY })],
      complete,
      NOW,
      TZ,
    );
    expect(action).toBeNull();
  });

  it("falls back to the headshot then the bio when no tasks are open", () => {
    expect(nextAction([], { hasBio: true, hasHeadshot: false }, NOW, TZ)?.to).toBe("/portal/profile");
    expect(nextAction([], { hasBio: true, hasHeadshot: false }, NOW, TZ)?.label).toBe("Add a headshot");
    expect(nextAction([], { hasBio: false, hasHeadshot: true }, NOW, TZ)?.label).toBe("Write your bio");
  });

  it("returns null when there is genuinely nothing to do", () => {
    expect(nextAction([], complete, NOW, TZ)).toBeNull();
  });

  /* must-not-fire: a profile gap never outranks a real task */
  it("does NOT prefer a profile gap over an open task", () => {
    const action = nextAction(
      [task({ id: "t", title: "Confirm your slot", dueAt: NOW + DAY })],
      { hasBio: false, hasHeadshot: false },
      NOW,
      TZ,
    );
    expect(action?.to).toBe("/portal/tasks/t");
  });
});

describe("profileCompleteness", () => {
  it("reports 100% for a fully filled profile", () => {
    const result = profileCompleteness({
      fullName: "Sam Speaker",
      bio: "A bio.",
      headshotKey: "k",
      company: "Callboard",
      title: "Demo Speaker",
      links: { website: "https://example.com" },
    });
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("names what is missing", () => {
    const result = profileCompleteness({
      fullName: "Sam",
      bio: "   ",
      headshotKey: null,
      company: null,
      title: "Demo",
      links: { website: "" },
    });
    expect(result.missing).toEqual(["bio", "headshot", "company", "a link"]);
    expect(result.percent).toBe(33);
  });

  it("handles an entirely empty profile", () => {
    const result = profileCompleteness({
      fullName: null,
      bio: null,
      headshotKey: null,
      company: null,
      title: null,
      links: null,
    });
    expect(result.percent).toBe(0);
    expect(result.missing).toHaveLength(6);
  });
});

describe("date formatting", () => {
  /*
   * This used to assert the UTC hardcode and so PINNED the +1-day bug in place
   * (SPK-05 / CNT-01). The property that actually mattered — SSR and hydration
   * agreeing — is preserved by the zone being loader data rather than the
   * browser's, and it is now the EVENT's zone that decides the day.
   */
  it("formats a due date in the event's zone, not UTC", () => {
    const lateEvening = Date.UTC(2026, 7, 18, 23, 30);
    expect(formatDueDate(lateEvening, "UTC")).toBe("Aug 18");
    // Same instant, and genuinely a different calendar day west of Greenwich.
    expect(formatDueDate(lateEvening, "America/Los_Angeles")).toBe("Aug 18");
    expect(formatDueDate(lateEvening, "Pacific/Auckland")).toBe("Aug 19");
  });

  it("describes relative due dates", () => {
    expect(relativeDue(NOW, NOW)).toBe("today");
    expect(relativeDue(NOW + DAY, NOW)).toBe("tomorrow");
    expect(relativeDue(NOW - DAY, NOW)).toBe("yesterday");
    expect(relativeDue(NOW + 5 * DAY, NOW)).toBe("in 5 days");
    expect(relativeDue(NOW - 5 * DAY, NOW)).toBe("5 days ago");
  });
});
