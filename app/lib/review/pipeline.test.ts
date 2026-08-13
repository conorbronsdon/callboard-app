import { describe, expect, it } from "vitest";

import { SESSION_STATUSES } from "~/db/schema";

import {
  ADMIN_ASSIGNABLE_STATUSES,
  STATUS_TABS,
  isAdminAssignable,
  parseTab,
  planQueueCommit,
  statusLabel,
} from "./pipeline";

describe("status tabs", () => {
  it("covers all seven states exactly once (DECISIONS #15)", () => {
    expect(STATUS_TABS).toHaveLength(7);
    expect([...STATUS_TABS].map((tab) => tab.status).sort()).toEqual(
      [...SESSION_STATUSES].sort(),
    );
  });

  it("orders tabs the way the product does, not the way the enum does", () => {
    expect(STATUS_TABS.map((tab) => tab.label)).toEqual([
      "Accepted",
      "Accept Queue",
      "Pending",
      "Decline Queue",
      "Declined",
      "Withdrawn",
      "Drafts",
    ]);
  });

  it("falls back to Pending for a junk ?tab= value", () => {
    expect(parseTab("accept_queue")).toBe("accept_queue");
    expect(parseTab("bogus")).toBe("pending");
    expect(parseTab(null)).toBe("pending");
  });

  it("labels drafts as Drafts", () => {
    expect(statusLabel("draft")).toBe("Drafts");
  });
});

describe("admin-assignable statuses", () => {
  // must-fire
  it.each([...ADMIN_ASSIGNABLE_STATUSES])("accepts %s from the popover", (status) => {
    expect(isAdminAssignable(status)).toBe(true);
  });

  // must-not-fire: withdrawn is the speaker's word and draft is the form's
  it.each(["withdrawn", "draft", "", "accepted; drop table", null, undefined])(
    "rejects %s",
    (status) => {
      expect(isAdminAssignable(status)).toBe(false);
    },
  );
});

describe("planQueueCommit", () => {
  const pool = [
    { id: "a1", status: "accept_queue" as const },
    { id: "a2", status: "accept_queue" as const },
    { id: "d1", status: "decline_queue" as const },
    { id: "p1", status: "pending" as const },
    { id: "y1", status: "accepted" as const },
    { id: "n1", status: "declined" as const },
    { id: "w1", status: "withdrawn" as const },
    { id: "f1", status: "draft" as const },
  ];

  it("must fire: staged accepts and declines are picked up", () => {
    const plan = planQueueCommit(pool);
    expect(plan.accept).toEqual(["a1", "a2"]);
    expect(plan.decline).toEqual(["d1"]);
  });

  it("must NOT fire: every other status is left alone", () => {
    const plan = planQueueCommit(pool);
    expect(plan.untouched).toEqual(["p1", "y1", "n1", "w1", "f1"]);
    expect(plan.accept).not.toContain("p1");
    expect(plan.decline).not.toContain("p1");
  });

  it("is empty for an empty pool", () => {
    expect(planQueueCommit([])).toEqual({ accept: [], decline: [], untouched: [] });
  });
});
