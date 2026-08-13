/**
 * The template editor: loader values, both empty states, and the save/reset
 * round trip asserted against the DATABASE rather than a redirect status.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTemplate } from "~/lib/comms/templates.server";
import { DEFAULT_TEMPLATES } from "~/lib/comms/templates";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminTemplates, { TemplatesView, action, loader } from "./admin.templates";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(query = "") {
  const request = await signedInGet(
    `https://x.test/admin/templates${query}`,
    fixture.adminId,
  );
  return loader({ request, params: {}, context: {} } as unknown as LoaderArgs);
}

async function post(fields: Record<string, string>) {
  const request = await signedInPost(
    "https://x.test/admin/templates",
    fixture.adminId,
    fields,
  );
  return action({ request, params: {}, context: {} } as unknown as ActionArgs);
}

describe("loader", () => {
  it("lists every template and selects the first by default", async () => {
    const data = await load();

    expect(data.templates.map((template) => template.key)).toEqual([
      "submission_confirmation",
      "decision_accept",
      "decision_decline",
      "task_reminder",
      "schedule_invite",
      "schedule_update",
      "schedule_cancel",
      "portal_invite",
    ]);
    expect(data.selected?.key).toBe("submission_confirmation");
    expect(data.selected?.isCustomized).toBe(false);
  });

  it("selects the requested template", async () => {
    const data = await load("?key=schedule_cancel");
    expect(data.selected?.key).toBe("schedule_cancel");
    expect(data.selected?.subject).toBe(DEFAULT_TEMPLATES.schedule_cancel.subject);
  });

  it("MUST-NOT-FIRE: an unknown key falls back rather than 500ing", async () => {
    const data = await load("?key=not_a_template");
    expect(data.selected?.key).toBe("submission_confirmation");
  });

  it("renders the preview against sample data with no braces left over", async () => {
    const data = await load("?key=schedule_invite");
    expect(data.preview?.subject).toBe(
      "Your slot at Frontier AI Summit 2026: Shipping agents that survive contact with users",
    );
    expect(data.preview?.text).toContain("Main Stage");
    expect(data.preview?.text).not.toMatch(/\{\{/);
    expect(data.unknown).toEqual([]);
  });
});

describe("action: save", () => {
  it("MUST-FIRE: writes the override and the loader reads it back", async () => {
    const response = await post({
      intent: "save",
      key: "schedule_invite",
      subject: "You're on at {{session.time}}",
      body: "Hi {{first_name}} — {{session.title}} in {{session.room}}.",
    });

    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe(
      "/admin/templates?key=schedule_invite&saved=1",
    );

    const stored = await loadTemplate(fixture.eventId, "schedule_invite", ctx.db);
    expect(stored.isCustomized).toBe(true);
    expect(stored.subject).toBe("You're on at {{session.time}}");

    const data = await load("?key=schedule_invite");
    expect(data.selected?.subject).toBe("You're on at {{session.time}}");
    expect(data.preview?.subject).toBe(
      "You're on at Wed Oct 7, 2026 · 10:00 AM – 10:30 AM",
    );
  });

  it("editing twice updates the same row rather than colliding on the unique index", async () => {
    await post({ intent: "save", key: "task_reminder", subject: "One", body: "First" });
    await post({ intent: "save", key: "task_reminder", subject: "Two", body: "Second" });

    const stored = await loadTemplate(fixture.eventId, "task_reminder", ctx.db);
    expect(stored.subject).toBe("Two");
    expect(stored.body).toBe("Second");
  });

  it("MUST-NOT-FIRE: an empty subject or body is refused, and nothing is written", async () => {
    expect(await post({ intent: "save", key: "task_reminder", subject: "  ", body: "x" })).toEqual(
      { ok: false, error: "A subject is required — an empty one reads as spam." },
    );
    expect(await post({ intent: "save", key: "task_reminder", subject: "x", body: " " })).toEqual({
      ok: false,
      error: "A body is required.",
    });
    expect((await loadTemplate(fixture.eventId, "task_reminder", ctx.db)).isCustomized).toBe(
      false,
    );
  });

  it("MUST-NOT-FIRE: an unknown key is refused", async () => {
    expect(await post({ intent: "save", key: "acceptance", subject: "a", body: "b" })).toEqual({
      ok: false,
      error: '"acceptance" is not a known template.',
    });
  });

  it("MUST-NOT-FIRE: an unknown intent is refused", async () => {
    expect(await post({ intent: "delete", key: "task_reminder" })).toEqual({
      ok: false,
      error: 'Unknown intent "delete".',
    });
  });
});

describe("action: reset", () => {
  it("MUST-FIRE: drops the override and the built-in default comes back", async () => {
    await post({ intent: "save", key: "task_reminder", subject: "Custom", body: "Custom body" });
    expect((await loadTemplate(fixture.eventId, "task_reminder", ctx.db)).isCustomized).toBe(true);

    const response = await post({ intent: "reset", key: "task_reminder" });
    expect((response as Response).headers.get("location")).toBe(
      "/admin/templates?key=task_reminder&reset=1",
    );

    const stored = await loadTemplate(fixture.eventId, "task_reminder", ctx.db);
    expect(stored.isCustomized).toBe(false);
    expect(stored.subject).toBe(DEFAULT_TEMPLATES.task_reminder.subject);
    expect(stored.body).toBe(DEFAULT_TEMPLATES.task_reminder.body);
  });

  it("MUST-NOT-FIRE: resetting an untouched template is a no-op, not an error", async () => {
    const response = await post({ intent: "reset", key: "schedule_update" });
    expect((response as Response).status).toBe(302);
    expect((await loadTemplate(fixture.eventId, "schedule_update", ctx.db)).isCustomized).toBe(
      false,
    );
  });
});

describe("render", () => {
  it("renders the seeded state with the editor, preview and field list", async () => {
    const data = await load("?key=schedule_invite");
    const html = renderToStaticMarkup(<TemplatesView {...data} />);

    expect(html).toContain('data-testid="templates"');
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="body"');
    expect(html).toContain('data-testid="template-preview"');
    expect(html).toContain("{{speaker.first_name}}");
    expect(html).toContain("Reset to default");
    // One tab per template — TEMPLATE_KEYS grew an eighth entry (portal_invite,
    // SPK-06) beside the original seven.
    expect(html.split('href="/admin/templates?key=').length - 1).toBe(8);
  });

  it("renders the ZERO state when no event exists", () => {
    const html = renderToStaticMarkup(
      <TemplatesView
        event={null}
        templates={[]}
        selected={null}
        preview={null}
        unknown={[]}
        fields={[]}
        saved={null}
        reset={null}
      />,
    );
    expect(html).toContain('data-testid="templates-empty"');
    expect(html).toContain("Create one in Settings first.");
  });

  it("MUST-FIRE: warns about an unknown merge field after a save", async () => {
    await post({
      intent: "save",
      key: "task_reminder",
      subject: "Hi {{speker.name}}",
      body: "Body {{nonsense}}",
    });
    const data = await load("?key=task_reminder");

    expect(data.unknown.sort()).toEqual(["nonsense", "speker.name"]);
    const html = renderToStaticMarkup(<TemplatesView {...data} />);
    expect(html).toContain('data-testid="template-unknown-fields"');
    expect(html).toContain("speker.name");
  });

  it("MUST-NOT-FIRE: no warning when every field is valid", async () => {
    const data = await load("?key=task_reminder");
    const html = renderToStaticMarkup(<TemplatesView {...data} />);
    expect(html).not.toContain('data-testid="template-unknown-fields"');
  });

  it("the ROUTE default export renders the same screen from loader data", async () => {
    const props = { loaderData: await load() } as unknown as Parameters<
      typeof AdminTemplates
    >[0];
    expect(renderToStaticMarkup(<AdminTemplates {...props} />)).toContain(
      'data-testid="templates"',
    );
  });
});
