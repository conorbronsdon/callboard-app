import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RevisionHistory,
  toRevisionEntries,
} from "~/components/revision-history";
import type { SessionRevisionRow } from "~/lib/admin/session-revisions.server";

const rows: SessionRevisionRow[] = [
  {
    id: "newest",
    title: "Final title",
    description: "A final abstract",
    editorPersonId: "admin",
    editorName: "Ada Organiser",
    source: "admin_edit",
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
  },
  {
    id: "middle",
    title: "Working title",
    description: "Short",
    editorPersonId: "admin",
    editorName: "Ada Organiser",
    source: "admin_edit",
    createdAt: new Date("2026-08-12T11:00:00.000Z"),
  },
  {
    id: "oldest",
    title: "Working title",
    description: "Tiny",
    editorPersonId: null,
    editorName: "Sam Speaker",
    source: "submit",
    createdAt: new Date("2026-08-12T10:00:00.000Z"),
  },
];

describe("revision history shaping", () => {
  it("MUST FIRE: compares each revision with its next-older version", () => {
    const entries = toRevisionEntries(rows);

    expect(entries.map((entry) => entry.isCurrent)).toEqual([true, false, false]);
    expect(entries[0].titleChangedFrom).toBe("Working title");
    expect(entries[0].descriptionLengthDelta).toBe(11);
  });

  it("MUST NOT FIRE: equal and oldest titles do not invent a prior change", () => {
    const entries = toRevisionEntries(rows);

    expect(entries[1].titleChangedFrom).toBeNull();
    expect(entries[2].titleChangedFrom).toBeNull();
    expect(entries[2].previousDescriptionLength).toBeNull();
  });
});

describe("revision history restore controls", () => {
  it("MUST FIRE: renders one restore control for every non-current entry", () => {
    const html = renderToStaticMarkup(
      <RevisionHistory entries={toRevisionEntries(rows)} canRestore />,
    );

    expect(html.match(/data-restore-revision=/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('data-restore-revision="newest"');
  });

  it("MUST NOT FIRE: hides every restore control when restore is unavailable", () => {
    const html = renderToStaticMarkup(
      <RevisionHistory entries={toRevisionEntries(rows)} canRestore={false} />,
    );

    expect(html.match(/data-restore-revision=/g) ?? []).toHaveLength(0);
  });
});
