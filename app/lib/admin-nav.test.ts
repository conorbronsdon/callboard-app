import { describe, expect, it } from "vitest";

import {
  buildAdminNav,
  coverageGaps,
  isAdminNavGroup,
  type AdminNavEntry,
} from "~/lib/admin-nav";

const CANONICAL_LABELS = [
  "Dashboard",
  "Agenda",
  "Submissions",
  "Speakers",
  "Tasks",
  "Forms",
  "Portal forms",
  "Templates",
  "Review ops",
  "Reviewer workspace",
  "Contacts",
  "Pipeline",
  "Resources",
  "Files",
  "Embeds",
  "Comms",
  "Settings",
  "Integrations",
  "API keys",
  "Jobs",
  "View as",
];

describe("admin nav coverage", () => {
  it("MUST FIRE: reports one omitted destination from every group", () => {
    const broken: AdminNavEntry[] = [
      {
        key: "programme",
        label: "Programme",
        items: [{ to: "/admin/agenda", label: "Agenda" }],
      },
      {
        key: "cfp",
        label: "CFP & Forms",
        items: [{ to: "/admin/forms", label: "Forms" }],
      },
    ];

    expect(coverageGaps(broken, ["Agenda", "Submissions", "Forms", "Templates"])).toEqual({
      missing: ["Submissions", "Templates"],
      duplicated: [],
    });
  });

  it("MUST FIRE: reports a destination duplicated across groups", () => {
    const broken: AdminNavEntry[] = [
      {
        key: "content",
        label: "Content",
        items: [{ to: "/admin/files", label: "Files" }],
      },
      {
        key: "settings",
        label: "Settings",
        items: [{ to: "/admin/files", label: "Files" }],
      },
    ];

    expect(coverageGaps(broken, ["Files"])).toEqual({
      missing: [],
      duplicated: ["Files"],
    });
  });

  it("MUST NOT FIRE: accounts for every canonical destination exactly once", () => {
    expect(coverageGaps(buildAdminNav("/review"), CANONICAL_LABELS)).toEqual({
      missing: [],
      duplicated: [],
    });
  });
});

describe("admin nav information architecture", () => {
  it("pins the exact top-level order and group membership", () => {
    const entries = buildAdminNav("/review?event=frontier-ai-summit-2026");

    expect(entries.map((entry) => entry.label)).toEqual([
      "Dashboard",
      "Programme",
      "CFP & Forms",
      "Review",
      "People",
      "Content",
      "Comms",
      "Settings",
    ]);

    const groups = Object.fromEntries(
      entries
        .filter(isAdminNavGroup)
        .map((entry) => [entry.key, entry.items.map((item) => item.label)]),
    );
    expect(groups.programme).toEqual(["Agenda", "Submissions", "Speakers", "Tasks"]);
    expect(groups.cfp).toEqual(["Forms", "Portal forms", "Templates"]);
    expect(groups.review).toEqual(["Review ops", "Reviewer workspace"]);
    expect(groups.people).toEqual(["Contacts", "Pipeline"]);
    expect(groups.content).toEqual(["Resources", "Files", "Embeds"]);
    expect(groups.settings).toEqual([
      "Settings",
      "Integrations",
      "API keys",
      "Jobs",
      "View as",
    ]);
  });

  it("threads the selected event into the reviewer workspace link", () => {
    const review = buildAdminNav("/review?event=frontier-ai-summit-2026").find(
      (entry) => isAdminNavGroup(entry) && entry.key === "review",
    );

    expect(review).toBeDefined();
    expect(isAdminNavGroup(review!)).toBe(true);
    if (!review || !isAdminNavGroup(review)) throw new Error("Review group missing");
    expect(review.items).toEqual([
      { to: "/admin/reviews", label: "Review ops" },
      {
        to: "/review?event=frontier-ai-summit-2026",
        label: "Reviewer workspace",
      },
    ]);
  });

  it("discriminates a plain link from a disclosure group", () => {
    expect(isAdminNavGroup({ to: "/admin", label: "Dashboard", end: true })).toBe(false);
    expect(
      isAdminNavGroup({
        key: "programme",
        label: "Programme",
        items: [{ to: "/admin/agenda", label: "Agenda" }],
      }),
    ).toBe(true);
  });
});
