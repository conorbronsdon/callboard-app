import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import AdminForms from "./admin.forms";

type FormRow = {
  id: string;
  name: string;
  target: "submission";
  status: "draft" | "open" | "closed";
  collectParticipants: boolean;
  fieldCount: number;
  ruleCount: number;
  routeCount: number;
  closesAt: string | null;
  createdAt: string;
  submissions: number;
  drafts: number;
  pending: number;
};

const row = (over: Partial<FormRow> & Pick<FormRow, "id" | "name">): FormRow => ({
  target: "submission",
  status: "open",
  collectParticipants: true,
  fieldCount: 1,
  ruleCount: 0,
  routeCount: 0,
  closesAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  submissions: 0,
  drafts: 0,
  pending: 0,
  ...over,
});

function markup(forms: FormRow[], entry = "/admin/forms"): string {
  const loaderData = {
    eventSlug: "world-fair",
    timezone: "UTC",
    origin: "https://callboard.test",
    forms,
  };
  const Stub = createRoutesStub([
    {
      path: "/admin/forms",
      Component: () =>
        AdminForms({ loaderData, actionData: undefined } as unknown as Parameters<
          typeof AdminForms
        >[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={[entry]} />);
}

function statusMarkup(html: string, id: string): string {
  const start = html.indexOf(`data-testid="form-status-${id}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</span>", start) + 7);
}

describe("admin form status follows the public close-date gate", () => {
  it("badges and filters a stored-open form with a past close date as closed", () => {
    const past = row({
      id: "past",
      name: "Past deadline",
      closesAt: "2000-01-01T00:00:00.000Z",
    });

    const html = markup([past]);
    expect(statusMarkup(html, "past")).toContain(">closed</span>");
    expect(html).toContain("Open 0");
    expect(html).toContain("Closed 1");

    const closedTab = markup([past], "/admin/forms?status=closed");
    expect(closedTab).toContain('data-testid="form-status-past"');
    const openTab = markup([past], "/admin/forms?status=open");
    expect(openTab).not.toContain('data-testid="form-status-past"');
  });

  it("keeps future and dateless open forms open while leaving drafts distinct", () => {
    const future = row({
      id: "future",
      name: "Future deadline",
      closesAt: "2999-01-01T00:00:00.000Z",
    });
    const dateless = row({ id: "dateless", name: "No deadline", closesAt: null });
    const draft = row({ id: "draft", name: "Draft form", status: "draft" });

    const html = markup([future, dateless, draft]);
    expect(statusMarkup(html, "future")).toContain(">open</span>");
    expect(statusMarkup(html, "dateless")).toContain(">open</span>");
    expect(statusMarkup(html, "draft")).toContain(">draft</span>");
    expect(html).toContain("Open 2");
    expect(html).toContain("Closed 0");

    const openTab = markup([future, dateless, draft], "/admin/forms?status=open");
    expect(openTab).toContain('data-testid="form-status-future"');
    expect(openTab).toContain('data-testid="form-status-dateless"');
    expect(openTab).not.toContain('data-testid="form-status-draft"');
  });
});
