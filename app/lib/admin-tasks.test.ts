import { describe, expect, it } from "vitest";

import {
  filterTasks,
  groupBySpeaker,
  groupByTask,
  parseTaskFilters,
  progressOf,
  type AdminTaskRow,
} from "./admin-tasks";

const NOW = Date.UTC(2027, 3, 10, 12);

function task(overrides: Partial<AdminTaskRow> & { id: string }): AdminTaskRow {
  return {
    title: "Confirm participation",
    description: null,
    kind: "manual",
    status: "pending",
    dueAt: NOW + 86_400_000,
    completedAt: null,
    templateId: null,
    formId: null,
    personId: "speaker-a",
    personName: "Ada Lovelace",
    personEmail: "ada@example.test",
    sessionId: null,
    sessionTitle: null,
    ...overrides,
  };
}

const ROWS = [
  task({ id: "a-complete", status: "complete" }),
  task({ id: "a-overdue", dueAt: NOW - 1 }),
  task({ id: "b-upload", kind: "upload", personId: "speaker-b", personName: "Grace Hopper" }),
  task({ id: "b-later", personId: "speaker-b", personName: "Grace Hopper", dueAt: NOW + 10 * 86_400_000 }),
  task({ id: "b-none", personId: "speaker-b", personName: "Grace Hopper", dueAt: null }),
];

describe("admin task filters", () => {
  it("must fire: parses supported filters and rejects unknown enum values", () => {
    expect(parseTaskFilters(new URLSearchParams("status=complete&person=speaker-b&kind=upload&due=soon&view=speaker"))).toEqual({
      status: "complete",
      person: "speaker-b",
      kind: "upload",
      due: "soon",
      view: "speaker",
    });
    expect(parseTaskFilters(new URLSearchParams("status=broken&kind=csv&due=later&view=grid"))).toEqual({
      status: "all",
      person: "all",
      kind: "all",
      due: "all",
      view: "task",
    });
  });

  it("must fire: narrows every status person kind and due predicate to exact ids", () => {
    const filters = parseTaskFilters;
    expect(filterTasks(ROWS, filters(new URLSearchParams()), NOW).map((row) => row.id)).toEqual([
      "a-complete", "a-overdue", "b-upload", "b-later", "b-none",
    ]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("status=incomplete")), NOW).map((row) => row.id)).toEqual([
      "a-overdue", "b-upload", "b-later", "b-none",
    ]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("status=complete")), NOW).map((row) => row.id)).toEqual(["a-complete"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("status=overdue")), NOW).map((row) => row.id)).toEqual(["a-overdue"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("person=speaker-b")), NOW).map((row) => row.id)).toEqual(["b-upload", "b-later", "b-none"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("kind=upload")), NOW).map((row) => row.id)).toEqual(["b-upload"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("due=overdue")), NOW).map((row) => row.id)).toEqual(["a-overdue"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("due=soon")), NOW).map((row) => row.id)).toEqual(["b-upload"]);
    expect(filterTasks(ROWS, filters(new URLSearchParams("due=none")), NOW).map((row) => row.id)).toEqual(["b-none"]);
  });

  it("must NOT fire: complete and overdue rows stay out of due-soon results", () => {
    const ids = filterTasks(ROWS, parseTaskFilters(new URLSearchParams("due=soon")), NOW).map((row) => row.id);
    expect(ids).not.toContain("a-complete");
    expect(ids).not.toContain("a-overdue");
    expect(ids).not.toContain("b-later");
  });
});

describe("admin task grouping", () => {
  it("must fire: groups template instances and fallback-key instances together", () => {
    const grouped = groupByTask([
      task({ id: "one", templateId: "template-1" }),
      task({ id: "two", templateId: "template-1", personId: "speaker-b" }),
      task({ id: "three", title: "Headshot", kind: "upload", dueAt: null }),
      task({ id: "four", title: "Headshot", kind: "upload", dueAt: null, personId: "speaker-b" }),
    ]);
    expect(grouped.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ["template-1", ["one", "two"]],
      ["Headshot|null|upload", ["three", "four"]],
    ]);
  });

  it("must NOT fire: different due dates do not collapse into one fallback group", () => {
    expect(groupByTask([task({ id: "one" }), task({ id: "two", dueAt: NOW + 2 })])).toHaveLength(2);
  });

  it("must fire: groups by speaker and counts waived tasks as complete", () => {
    const rows = [task({ id: "one", status: "waived" }), task({ id: "two" }), task({ id: "three", personId: "speaker-b", personName: "Grace Hopper" })];
    expect(groupBySpeaker(rows).map((group) => [group.personId, group.rows.map((row) => row.id)])).toEqual([
      ["speaker-a", ["one", "two"]],
      ["speaker-b", ["three"]],
    ]);
    expect(progressOf(rows.slice(0, 2))).toEqual({ complete: 1, total: 2, percent: 50 });
  });

  it("must NOT fire: pending tasks do not increase completed progress", () => {
    expect(progressOf([task({ id: "pending" })])).toEqual({ complete: 0, total: 1, percent: 0 });
  });
});
