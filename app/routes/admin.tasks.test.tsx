import { and, asc, eq, inArray } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { events, forms, taskTemplates, tasks } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { EVENT_COOKIE_NAME } from "~/lib/event.server";
import { readPortalSchema } from "~/lib/portal-form";
import { formatDueDate } from "~/lib/portal-progress";
import { RATE_LIMIT_POLICIES } from "~/lib/rate-limit.server";
import { applyAbstractStatus } from "~/lib/review/commit.server";
import { zonedInputToEpoch } from "~/lib/zoned-time";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  CFP_FORM_ID,
  EVENT_SLUG,
  OTHER_EVENT_SLUG,
  SPEAKERS,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";
import { env } from "~/test/workers-env";

import AdminTasks, { TasksView, action, loader } from "./admin.tasks";
import {
  SpeakerView,
  loader as adminSpeakerLoader,
  speakerLoaderPayload,
} from "./admin.speaker";
import PortalTask, { action as portalTaskAction, loader as portalTaskLoader } from "./portal.task";
import PortalTasks, { loader as portalTasksLoader } from "./portal.tasks";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type PortalTaskArgs = Parameters<typeof portalTaskLoader>[0];
type PortalTasksArgs = Parameters<typeof portalTasksLoader>[0];
type AdminSpeakerArgs = Parameters<typeof adminSpeakerLoader>[0];

const args = (request: Request) => ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const actionArgs = (request: Request) => ({ request, params: {}, context: {} }) as unknown as ActionArgs;
const portalArgs = (request: Request, taskId: string) =>
  ({ request, params: { taskId }, context: {} }) as unknown as PortalTaskArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

const PORTAL_FORM_ID = "46000000-0000-4000-8000-000000000001";
const OTHER_PORTAL_FORM_ID = "46000000-0000-4000-8000-000000000002";

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function adminRequest(
  url: string,
  method: "GET" | "POST" = "GET",
  fields: [string, string][] = [],
  eventSlug?: string,
): Promise<Request> {
  const session = (await createLoginSession(new Request(url), fixture.adminId)).split(";")[0];
  const cookie = eventSlug
    ? `${session}; ${EVENT_COOKIE_NAME}=${encodeURIComponent(eventSlug)}`
    : session;
  if (method === "GET") return new Request(url, { headers: { cookie } });
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return new Request(url, {
    method,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function load(search = "", eventSlug?: string) {
  return loader(args(await adminRequest(`https://x.test/admin/tasks${search}`, "GET", [], eventSlug)));
}

async function post(fields: [string, string][], eventSlug?: string) {
  return action(actionArgs(await adminRequest("https://x.test/admin/tasks", "POST", fields, eventSlug)));
}

async function createManual(
  title = "Confirm participation",
  people = fixture.speakerIds.slice(0, 2),
  dueOn = "2027-04-01",
) {
  return post([
    ["intent", "create"], ["title", title], ["instructions", "Please confirm."],
    ["taskType", "general"], ["dueOn", dueOn], ["assignTo", "selected"],
    ...people.map((id) => ["personIds", id] as [string, string]),
  ]);
}

async function createFileRequest(title: string, dueOn: string, assignTo = "all") {
  return post([
    ["intent", "create"], ["title", title],
    ["instructions", "Final slide deck as a PDF, 16:9 aspect ratio."],
    ["taskType", "file-request"], ["dueOn", dueOn], ["assignTo", assignTo],
    ...(assignTo === "selected" ? [["personIds", fixture.speakerIds[0]] as [string, string]] : []),
  ]);
}

async function createPortalForm(options: {
  id?: string;
  eventId?: string;
  name?: string;
  schema?: Record<string, unknown>;
} = {}) {
  const id = options.id ?? PORTAL_FORM_ID;
  await ctx.db.insert(forms).values({
    id,
    eventId: options.eventId ?? fixture.eventId,
    surface: "portal",
    target: "submission",
    status: "open",
    name: options.name ?? "Speaker logistics",
    schema: options.schema ?? {
      sectionTitle: "Travel and dietary details",
      questions: [
        { key: "travel_date", label: "Travel arrival date", type: "date" },
        { key: "dietary_needs", label: "Dietary needs", type: "textarea" },
      ],
    },
    settings: { surface: "portal", type: "submissions", requireLogin: true },
  });
  return id;
}

async function createFormTask(
  formId: string,
  title = "Complete speaker logistics",
  people = fixture.speakerIds.slice(0, 2),
  alsoTemplate = false,
) {
  return post([
    ["intent", "create"], ["title", title], ["instructions", "Tell us what you need."],
    ["taskType", "form"], ["formId", formId], ["assignTo", "selected"],
    ...people.map((id) => ["personIds", id] as [string, string]),
    ...(alsoTemplate ? [["alsoTemplate", "on"] as [string, string]] : []),
  ]);
}

function count(table: "tasks" | "forms", eventId = fixture.eventId): number {
  return (ctx.sqlite.prepare(`select count(*) as n from ${table} where event_id = ?`).get(eventId) as { n: number }).n;
}

function createTestBucket() {
  const objects = new Map<string, unknown>();
  return {
    objects,
    binding: {
      async put(key: string) { objects.set(key, {}); },
      async get(key: string) { return objects.has(key) ? ({} as unknown) : null; },
      async delete(key: string) { objects.delete(key); },
    },
  };
}

async function upload(personId: string, taskId: string): Promise<Response> {
  const body = new FormData();
  body.set("intent", "submit-form");
  body.set("deliverable", new File(["bytes"], "deck.txt", { type: "text/plain" }));
  const signed = await signedInGet(`https://x.test/portal/tasks/${taskId}`, personId);
  const request = new Request(signed.url, {
    method: "POST",
    headers: { cookie: signed.headers.get("cookie") as string },
    body,
  });
  try {
    await portalTaskAction(portalArgs(request, taskId) as never);
    return new Response(null, { status: 200 });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function renderWithRouter(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("organizer task creation", () => {
  it("must fire: creates exact manual rows for two roster speakers at event-local end of day", async () => {
    const before = count("tasks");
    const response = await createManual();
    expect((response as Response).status).toBe(302);
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.title, "Confirm participation")).orderBy(asc(tasks.personId));
    expect(count("tasks")).toBe(before + 2);
    expect(rows.map((row) => row.personId)).toEqual([...fixture.speakerIds.slice(0, 2)].sort());
    expect(rows.map((row) => ({ title: row.title, status: row.status, kind: row.kind, formId: row.formId, response: row.response, dueAt: row.dueAt?.getTime() }))).toEqual([
      { title: "Confirm participation", status: "pending", kind: "manual", formId: null, response: null, dueAt: zonedInputToEpoch("2027-04-01T23:59", "America/Los_Angeles") },
      { title: "Confirm participation", status: "pending", kind: "manual", formId: null, response: null, dueAt: zonedInputToEpoch("2027-04-01T23:59", "America/Los_Angeles") },
    ]);
  });

  it("must fire: loader and list markup expose title both assignees and exact formatted due date", async () => {
    await createManual();
    const data = await load();
    const created = data.rows.filter((row) => row.title === "Confirm participation");
    expect(created.map((row) => row.personName).sort()).toEqual(SPEAKERS.slice(0, 2).map((person) => person.name).sort());
    const html = renderWithRouter(<TasksView {...data} />);
    expect(html).toContain("Confirm participation");
    expect(html).toContain(SPEAKERS[0].name);
    expect(html).toContain(SPEAKERS[1].name);
    /*
     * The LITERAL day the organizer typed, not `formatDueDate(...)` of the same
     * epoch — that spelling computed the expectation with the function under
     * test and stayed green while every screen rendered "Apr 2" (SPK-05/CNT-01).
     * The fixture event is America/Los_Angeles, so this is the discriminating
     * direction: a relapse to UTC rendering turns this red.
     */
    expect(zonedInputToEpoch("2027-04-01T23:59", "America/Los_Angeles")).not.toBeNull();
    expect(html).toContain("Apr 1");
    expect(html).not.toContain("Apr 2");
    const routeProps = { loaderData: data, actionData: undefined } as unknown as Parameters<typeof AdminTasks>[0];
    expect(renderWithRouter(<AdminTasks {...routeProps} />)).toContain('data-testid="admin-tasks"');
  });

  it("must NOT fire: empty title inserts no task rows", async () => {
    const before = count("tasks");
    expect(await post([["intent", "create"], ["title", " "], ["taskType", "general"], ["assignTo", "all"]])).toEqual({
      ok: false,
      error: "A title is required and must be 200 characters or fewer.",
    });
    expect(count("tasks")).toBe(before);
  });

  it("must NOT fire: a general task creates zero forms", async () => {
    const before = count("forms");
    await createManual("General without a form");
    expect(count("forms")).toBe(before);
    const rows = await ctx.db.select({ kind: tasks.kind, formId: tasks.formId, response: tasks.response }).from(tasks).where(eq(tasks.title, "General without a form"));
    expect(rows).toEqual([
      { kind: "manual", formId: null, response: null },
      { kind: "manual", formId: null, response: null },
    ]);
  });

  it("must fire: complete reopen and delete mutate only the chosen row", async () => {
    await createManual("Organizer CRUD", [fixture.speakerIds[0]]);
    const created = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Organizer CRUD") });
    await post([["intent", "complete"], ["taskId", created!.id]]);
    const completed = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, created!.id) });
    expect(completed?.status).toBe("complete");
    expect(completed?.completedById).toBe(fixture.adminId);
    expect(completed?.completedAt?.getTime()).toEqual(expect.any(Number));

    await post([["intent", "reopen"], ["taskId", created!.id]]);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, created!.id) })).toMatchObject({
      status: "pending", completedAt: null, completedById: null,
    });

    await post([["intent", "delete"], ["taskId", created!.id]]);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, created!.id) })).toBeUndefined();
  });
});

describe("organizer file requests and portal coexistence", () => {
  it("must fire: creates one shared file form and a pending upload row for every roster speaker", async () => {
    const formsBefore = count("forms");
    await createFileRequest("Upload Session Presentation", "2027-05-01");
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.title, "Upload Session Presentation"));
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.personId).sort()).toEqual([...fixture.speakerIds].sort());
    expect(new Set(rows.map((row) => row.formId)).size).toBe(1);
    expect(rows[0].formId).not.toBeNull();
    expect(rows.map((row) => [row.kind, row.status, row.dueAt?.getTime()])).toEqual(
      Array(8).fill(["upload", "pending", zonedInputToEpoch("2027-05-01T23:59", "America/Los_Angeles")]),
    );
    expect(rows.map((row) => row.response)).toEqual(Array(8).fill(null));
    expect(count("forms")).toBe(formsBefore + 1);
    const form = await ctx.db.query.forms.findFirst({ where: eq(forms.id, rows[0].formId!) });
    expect(form?.id).toBe(rows[0].formId);
    expect(form?.eventId).toBe(fixture.eventId);
    expect(form?.surface).toBe("portal");
    expect(form?.name).toBe("Upload Session Presentation");
    expect(readPortalSchema(form?.schema).questions).toEqual([{ key: "deliverable", label: "Upload your file", type: "file", required: true, filePurpose: "document" }]);
  });

  it("must fire: both named deliverables coexist at their distinct exact due epochs", async () => {
    await createFileRequest("Upload Session Presentation", "2027-05-01");
    await createFileRequest("Upload Final Headshot (print quality)", "2027-04-14");
    const rows = await ctx.db.select({ title: tasks.title, dueAt: tasks.dueAt }).from(tasks).where(inArray(tasks.title, ["Upload Session Presentation", "Upload Final Headshot (print quality)"]));
    expect(rows.filter((row) => row.title === "Upload Session Presentation").map((row) => row.dueAt?.getTime())).toEqual(Array(8).fill(zonedInputToEpoch("2027-05-01T23:59", "America/Los_Angeles")));
    expect(rows.filter((row) => row.title === "Upload Final Headshot (print quality)").map((row) => row.dueAt?.getTime())).toEqual(Array(8).fill(zonedInputToEpoch("2027-04-14T23:59", "America/Los_Angeles")));
  });

  it("must fire: a created manual task appears in the real speaker portal list and markup", async () => {
    await createManual();
    const request = await signedInGet("https://x.test/portal/tasks", fixture.speakerIds[0]);
    const data = await portalTasksLoader({ request, params: {}, context: {} } as unknown as PortalTasksArgs);
    expect(data.tasks.find((row) => row.title === "Confirm participation")?.id).toEqual(expect.any(String));
    const portalProps = { loaderData: data } as unknown as Parameters<typeof PortalTasks>[0];
    expect(renderWithRouter(<PortalTasks {...portalProps} />)).toContain("Confirm participation");
  });

  it("must fire: a created file request loads the real portal form and renders a file input", async () => {
    await createFileRequest("Upload Session Presentation", "2027-05-01", "selected");
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Upload Session Presentation") });
    const request = await signedInGet(`https://x.test/portal/tasks/${row!.id}`, fixture.speakerIds[0]);
    const data = await portalTaskLoader(portalArgs(request, row!.id));
    expect(data.form?.schema.questions).toEqual([{ key: "deliverable", label: "Upload your file", type: "file", required: true, filePurpose: "document" }]);
    const portalProps = { loaderData: data, actionData: undefined } as unknown as Parameters<typeof PortalTask>[0];
    const router = createMemoryRouter([
      { path: "/portal/tasks/:taskId", element: <PortalTask {...portalProps} /> },
    ], { initialEntries: [`/portal/tasks/${row!.id}`] });
    expect(renderToStaticMarkup(<RouterProvider router={router} />)).toContain('type="file"');
  });

  it("must NOT fire: another speaker cannot load a created task row", async () => {
    await createManual("Private assignment", [fixture.speakerIds[0]]);
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Private assignment") });
    const request = await signedInGet(`https://x.test/portal/tasks/${row!.id}`, fixture.speakerIds[1]);
    await expect(portalTaskLoader(portalArgs(request, row!.id))).rejects.toMatchObject({ status: 404 });
  });
});

describe("organizer-authored portal form tasks", () => {
  it("must fire: creates exactly one form task per selected speaker with the chosen form id", async () => {
    await createPortalForm();
    const before = count("tasks");

    const response = await createFormTask(PORTAL_FORM_ID);

    expect((response as Response).status).toBe(302);
    const rows = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.title, "Complete speaker logistics"))
      .orderBy(asc(tasks.personId));
    expect(count("tasks")).toBe(before + 2);
    expect(rows.map((row) => row.personId)).toEqual([...fixture.speakerIds.slice(0, 2)].sort());
    expect(rows.map((row) => ({ kind: row.kind, formId: row.formId, response: row.response }))).toEqual([
      { kind: "form", formId: PORTAL_FORM_ID, response: null },
      { kind: "form", formId: PORTAL_FORM_ID, response: null },
    ]);
  });

  it.each([
    ["missing", [] as [string, string][]],
    ["blank", [["formId", " "]] as [string, string][]],
  ])("must NOT fire: a %s form id writes no task rows", async (_label, formIdFields) => {
    const before = count("tasks");
    const response = await post([
      ["intent", "create"], ["title", "Invalid form assignment"],
      ["taskType", "form"], ["assignTo", "selected"],
      ["personIds", fixture.speakerIds[0]], ...formIdFields,
    ]);
    expect(response).toEqual({ ok: false, error: "Choose a portal form from this event." });
    expect(count("tasks")).toBe(before);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Invalid form assignment") })).toBeUndefined();
  });

  it("must NOT fire: another event's portal form writes no task rows", async () => {
    const other = await seedOtherEvent(ctx.db);
    await createPortalForm({ id: OTHER_PORTAL_FORM_ID, eventId: other.eventId, name: "Europe logistics" });
    const before = count("tasks");

    const response = await createFormTask(OTHER_PORTAL_FORM_ID, "Cross-event form theft", [fixture.speakerIds[0]]);

    expect(response).toEqual({ ok: false, error: "Choose a portal form from this event." });
    expect(count("tasks")).toBe(before);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Cross-event form theft") })).toBeUndefined();
  });

  it("must NOT fire: this event's CFP form writes no task rows", async () => {
    const before = count("tasks");

    const response = await createFormTask(CFP_FORM_ID, "CFP form misuse", [fixture.speakerIds[0]]);

    expect(response).toEqual({ ok: false, error: "Choose a portal form from this event." });
    expect(count("tasks")).toBe(before);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "CFP form misuse") })).toBeUndefined();
  });

  it("must fire: loader and authoring markup expose the pinned portal form values", async () => {
    await createPortalForm({ name: "Speaker logistics" });

    const data = await load();

    expect(data.portalForms).toEqual([
      { id: PORTAL_FORM_ID, name: "Speaker logistics", questionCount: 2, status: "open" },
    ]);
    const html = renderWithRouter(<TasksView {...data} />);
    expect(html).toContain('<option value="form">Form</option>');
    expect(html).toContain(`value="${PORTAL_FORM_ID}"`);
    expect(html).toContain("Speaker logistics — 2 questions");
    expect(html).toContain('name="alsoTemplate"');
    expect(html).toContain("Also give this form to speakers accepted later");
  });

  /*
   * The picker has to survive with scripting off, because that is the only
   * state this screen has ever run in — the create form is a plain POST and
   * carries no client handlers. Shipped hidden behind an onChange it looked
   * fine in every other assertion here (a `hidden` element is still in the
   * markup and still matches `toContain`), while an organizer without JS could
   * choose Form and then never reach the select the action demands.
   */
  it("must NOT fire: the portal-form picker is never hidden behind a script-only reveal", async () => {
    await createPortalForm({ name: "Speaker logistics" });

    const html = renderWithRouter(<TasksView {...(await load())} />);

    const optionsBlock = html.match(/<div[^>]*data-form-task-options[^>]*>/);
    expect(optionsBlock).not.toBeNull();
    expect(optionsBlock![0]).not.toMatch(/\bhidden\b/);
    expect(html).toContain('name="formId"');
  });

  it("must NOT fire: zero portal forms renders the linked authoring hint", async () => {
    const data = await load();
    expect(data.portalForms).toEqual([]);
    const html = renderWithRouter(<TasksView {...data} />);
    expect(html).toContain("No portal forms yet.");
    expect(html).toContain("Create one in Portal forms");
    expect(html).toContain("to collect answers from speakers.");
    expect(html).toContain('href="/admin/portal-forms"');
  });

  it("must fire: form answers travel from admin assignment through the portal into the speaker custom-fields panel", async () => {
    await createPortalForm();
    await createFormTask(PORTAL_FORM_ID, "Complete speaker logistics", [fixture.speakerIds[0]]);
    const task = await ctx.db.query.tasks.findFirst({
      where: and(eq(tasks.title, "Complete speaker logistics"), eq(tasks.personId, fixture.speakerIds[0])),
    });

    const signed = await signedInGet(`https://x.test/portal/tasks/${task!.id}`, fixture.speakerIds[0]);
    const request = new Request(signed.url, {
      method: "POST",
      headers: {
        cookie: signed.headers.get("cookie") as string,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent: "submit-form",
        travel_date: "2027-03-31",
        dietary_needs: "Vegetarian, no shellfish",
      }),
    });
    await portalTaskAction(portalArgs(request, task!.id) as never);

    const completed = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, task!.id) });
    expect(completed?.response).toEqual({
      travel_date: "2027-03-31",
      dietary_needs: "Vegetarian, no shellfish",
    });

    const adminData = speakerLoaderPayload(
      await adminSpeakerLoader({
        request: await adminRequest(`https://x.test/admin/speakers/${fixture.speakerIds[0]}`),
        params: { id: fixture.speakerIds[0] },
        context: {},
      } as unknown as AdminSpeakerArgs),
    );
    const html = renderToStaticMarkup(<SpeakerView {...adminData} />);
    expect(html).toContain("Travel arrival date");
    expect(html).toContain("2027-03-31");
    expect(html).toContain("Dietary needs");
    expect(html).toContain("Vegetarian, no shellfish");
    expect(html).not.toContain(">travel_date<");
    expect(html).not.toContain(">dietary_needs<");
  });

  it("must fire: a future-acceptance template preserves the form id and mints a form-kind task", async () => {
    await createPortalForm();
    await createFormTask(
      PORTAL_FORM_ID,
      "Complete speaker logistics",
      [fixture.speakerIds[0]],
      true,
    );

    const template = await ctx.db.query.taskTemplates.findFirst({
      where: eq(taskTemplates.formId, PORTAL_FORM_ID),
    });
    expect(template).toMatchObject({
      eventId: fixture.eventId,
      title: "Complete speaker logistics",
      description: "Tell us what you need.",
      formId: PORTAL_FORM_ID,
      dueOffsetDays: null,
      isRequired: true,
      order: 0,
    });

    const abstractId = fixture.abstractIds[3];
    await applyAbstractStatus({
      eventId: fixture.eventId,
      abstractId,
      status: "accepted",
      db: ctx.db,
      notify: false,
    });
    const accepted = await ctx.db.query.tasks.findFirst({
      where: and(
        eq(tasks.personId, fixture.speakerIds[3]),
        eq(tasks.formId, PORTAL_FORM_ID),
      ),
    });
    expect(accepted?.templateId).toBe(template!.id);
    expect(accepted?.formId).toBe(PORTAL_FORM_ID);
    expect(accepted?.kind).toBe("form");
    expect(accepted?.dueAt).toBeNull();
  });
});

describe("created deliverable upload path", () => {
  it("must fire: repeated uploads hit the existing upload bucket and return 429", async () => {
    // `apiUpload` is a FIXED window (30/10min) snapping to wall-clock
    // :00/:10/:20/:30/:40/:50, and this route never threads an injectable `now`
    // down to `consumeRateLimit`. A run straddling one of those marks resets
    // the counter mid-flood, so the 429 assertion below would go red on the
    // wrong tree entirely. Same class of flake as
    // admin.reviews.provisioning.test.tsx's magic-link case; pin the clock with
    // the same vi.useFakeTimers()/vi.setSystemTime() idiom
    // app/lib/admin/session-revisions.server.test.ts already uses elsewhere.
    // 12:05:00 sits 5 minutes clear of the boundary on either side.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:05:00.000Z"));
    try {
      const bucket = createTestBucket();
      env.FILES = bucket.binding;
      await createFileRequest("Upload Session Presentation", "2027-05-01", "selected");
      const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Upload Session Presentation") });
      for (let attempt = 0; attempt < RATE_LIMIT_POLICIES.apiUpload.limit; attempt += 1) {
        expect((await upload(fixture.speakerIds[0], row!.id)).status).toBe(200);
      }
      expect((await upload(fixture.speakerIds[0], row!.id)).status).toBe(429);
      const buckets = ctx.sqlite.prepare("select scope, window_count from rate_limit_windows").all() as { scope: string; window_count: number }[];
      expect(buckets).toEqual([{ scope: "upload", window_count: RATE_LIMIT_POLICIES.apiUpload.limit }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("must NOT fire: one upload under the cap succeeds and leaves no pending task", async () => {
    const bucket = createTestBucket();
    env.FILES = bucket.binding;
    await createFileRequest("Upload Session Presentation", "2027-05-01", "selected");
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Upload Session Presentation") });
    expect((await upload(fixture.speakerIds[0], row!.id)).status).toBe(200);
    expect(await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, row!.id) })).toMatchObject({ status: "complete" });
    expect(bucket.objects.size).toBe(1);
  });
});

describe("task dashboard filters and views", () => {
  const ids = ["task-a-1", "task-a-2", "task-a-3", "task-b-1", "task-b-2", "task-b-3"];

  beforeEach(async () => {
    await ctx.db.delete(tasks).where(eq(tasks.eventId, fixture.eventId));
    const now = Date.now();
    await ctx.db.insert(tasks).values([
      { id: ids[0], eventId: fixture.eventId, personId: fixture.speakerIds[0], title: "A complete one", status: "complete", dueAt: new Date(now + 86_400_000), completedAt: new Date(now) },
      { id: ids[1], eventId: fixture.eventId, personId: fixture.speakerIds[0], title: "A complete two", status: "complete", dueAt: new Date(now + 2 * 86_400_000), completedAt: new Date(now) },
      { id: ids[2], eventId: fixture.eventId, personId: fixture.speakerIds[0], title: "A overdue", status: "pending", dueAt: new Date(now - 86_400_000) },
      { id: ids[3], eventId: fixture.eventId, personId: fixture.speakerIds[1], title: "B upload", kind: "upload", status: "pending", dueAt: new Date(now + 3 * 86_400_000) },
      { id: ids[4], eventId: fixture.eventId, personId: fixture.speakerIds[1], title: "B later", status: "pending", dueAt: new Date(now + 20 * 86_400_000) },
      { id: ids[5], eventId: fixture.eventId, personId: fixture.speakerIds[1], title: "B no date", status: "pending", dueAt: null },
    ]);
  });

  async function exact(search: string) {
    return (await load(search)).rows.map((row) => row.id).sort();
  }

  it("must fire: every loader filter returns exact task ids", async () => {
    expect(await exact("")).toEqual([...ids].sort());
    expect(await exact("?status=incomplete")).toEqual([ids[2], ids[3], ids[4], ids[5]].sort());
    expect(await exact("?status=complete")).toEqual([ids[0], ids[1]].sort());
    expect(await exact(`?person=${fixture.speakerIds[1]}`)).toEqual([ids[3], ids[4], ids[5]].sort());
    expect(await exact("?kind=upload")).toEqual([ids[3]]);
    expect(await exact("?due=overdue")).toEqual([ids[2]]);
    expect(await exact("?person=not-a-roster-person")).toEqual([...ids].sort());
  });

  it("must fire: both views expose exact speaker progress without drill-in", async () => {
    for (const search of ["?view=task", "?view=speaker"]) {
      const data = await load(search);
      const html = renderWithRouter(<TasksView {...data} />);
      expect(html).toContain("2 of 3 complete");
      expect(html).toContain("0 of 3 complete");
      expect(html).toContain(SPEAKERS[0].name);
      expect(html).toContain(SPEAKERS[1].name);
      for (const title of ["A complete one", "A complete two", "A overdue", "B upload", "B later", "B no date"]) expect(html).toContain(title);
    }
  });

  it("must NOT fire: an empty match renders only the no-match state and a zero count", async () => {
    const data = await load(`?status=complete&person=${fixture.speakerIds[1]}`);
    const html = renderWithRouter(<TasksView {...data} />);
    expect(data.rows).toEqual([]);
    expect(html).toContain('data-testid="admin-tasks-no-match"');
    expect(html).toContain('data-task-count="0"');
    for (const title of ["A complete one", "A complete two", "A overdue", "B upload", "B later", "B no date"]) expect(html).not.toContain(title);
  });

  it("must NOT fire: no stored tasks renders the distinct organizer empty state", async () => {
    await ctx.db.delete(tasks).where(eq(tasks.eventId, fixture.eventId));
    const data = await load();
    const html = renderWithRouter(<TasksView {...data} />);
    expect(html).toContain('data-testid="admin-tasks-empty"');
    expect(html).toContain("No tasks have been created for this event yet.");
    expect(html).not.toContain("No tasks yet");
  });

  /*
   * CNT-08: the reminder trigger deep-links to Comms with the
   * "outstanding_tasks" audience and "task_reminder" template pre-selected —
   * a two-click send (this link, then Comms' own Send button, which is where
   * the "Sent N of M" confirmation renders). It stays visible regardless of
   * the current filter, including when filtered to incomplete.
   */
  it("must fire: the outstanding-tasks reminder link is visible when filtered to incomplete, and deep-links correctly", async () => {
    const html = renderWithRouter(<TasksView {...(await load("?status=incomplete"))} />);
    expect(html).toContain("Send reminder to speakers with outstanding tasks");
    expect(html).toContain("/admin/comms?audience=outstanding_tasks&amp;template=task_reminder");
  });
});

describe("task event isolation and scoped actions", () => {
  let other: OtherEventFixture;
  beforeEach(async () => { other = await seedOtherEvent(ctx.db); });

  it("must fire: an event-A task appears in event A's loader", async () => {
    await createManual("Event A only task", [fixture.speakerIds[0]]);
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Event A only task") });
    expect((await load()).rows.map((item) => item.id)).toContain(row!.id);
  });

  it("must NOT fire: selecting event B leaks no event-A task or assignee token", async () => {
    await createManual("Secret Event A task", [fixture.speakerIds[0]]);
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.title, "Secret Event A task") });
    const payload = JSON.stringify(await load("", OTHER_EVENT_SLUG));
    expect(payload).not.toContain(row!.id);
    expect(payload).not.toContain("Secret Event A task");
    expect(payload).not.toContain(SPEAKERS[0].name);
    expect(payload).not.toContain(SPEAKERS[0].email);
  });

  it("must NOT fire: event B rejects an event-A assignee and changes neither event count", async () => {
    const beforeA = count("tasks", fixture.eventId);
    const beforeB = count("tasks", other.eventId);
    const response = await post([
      ["intent", "create"], ["title", "Cross event theft"], ["taskType", "general"],
      ["assignTo", "selected"], ["personIds", fixture.speakerIds[0]],
    ], OTHER_EVENT_SLUG);
    expect(response).toEqual({ ok: false, error: "Every assignee must belong to this event's speaker roster." });
    expect(count("tasks", fixture.eventId)).toBe(beforeA);
    expect(count("tasks", other.eventId)).toBe(beforeB);
  });

  it("must NOT fire: event B cannot complete an event-A task row", async () => {
    const row = await ctx.db.query.tasks.findFirst({ where: eq(tasks.eventId, fixture.eventId) });
    const before = { status: row!.status, completedAt: row!.completedAt?.getTime() ?? null };
    await post([["intent", "complete"], ["taskId", row!.id]], OTHER_EVENT_SLUG);
    const after = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, row!.id) });
    expect({ status: after!.status, completedAt: after!.completedAt?.getTime() ?? null }).toEqual(before);
  });

  it("must NOT fire: no-event loader returns its isolated empty shape", async () => {
    await ctx.db.delete(events);
    const data = await load();
    expect(data).toMatchObject({ event: null, roster: [], portalForms: [], rows: [], total: 0 });
    expect(renderWithRouter(<TasksView {...data} />)).toContain('data-task-count="0"');
  });
});

/**
 * SPK-12's roundtrip half: the organizer dashboard must "reflect portal
 * completions". Nothing in the organizer code does that explicitly — it falls
 * out of both sides reading `tasks.status` — which is exactly the kind of
 * implicit coupling that a later refactor breaks silently. Pin it by driving
 * the REAL portal action and re-reading the REAL admin loader.
 */
describe("portal completions surface on the organizer dashboard", () => {
  async function portalComplete(personId: string, taskId: string) {
    const signed = await signedInGet(`https://x.test/portal/tasks/${taskId}`, personId);
    const request = new Request(signed.url, {
      method: "POST",
      headers: {
        cookie: signed.headers.get("cookie") as string,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ intent: "complete" }),
    });
    return portalTaskAction(portalArgs(request, taskId) as never);
  }

  it("must fire: a speaker's portal completion flips that row and its progress on the organizer dashboard", async () => {
    await createManual("Confirm participation", fixture.speakerIds.slice(0, 2));
    const before = await load();
    const mine = before.rows.find(
      (row) => row.title === "Confirm participation" && row.personId === fixture.speakerIds[0],
    )!;
    expect(mine.status).toBe("pending");
    expect(mine.completedAt).toBeNull();

    await portalComplete(fixture.speakerIds[0], mine.id);

    const after = await load();
    const flipped = after.rows.find((row) => row.id === mine.id)!;
    expect(flipped.status).toBe("complete");
    expect(typeof flipped.completedAt).toBe("number");

    // List level — the organizer never opened the record. The speaker's
    // progress cell is counted independently here rather than by reusing
    // progressOf, so the assertion cannot agree with the code by construction.
    const done = (rows: typeof after.rows) =>
      rows.filter(
        (row) =>
          row.personId === fixture.speakerIds[0] &&
          (row.status === "complete" || row.status === "waived"),
      ).length;
    const mineTotal = after.rows.filter((row) => row.personId === fixture.speakerIds[0]).length;
    expect(done(after.rows)).toBe(done(before.rows) + 1);

    const html = renderWithRouter(<TasksView {...after} />);
    expect(html).toContain(`data-task-row="${mine.id}"`);
    expect(html).toContain('data-task-status="complete"');
    expect(html).toContain(`${done(after.rows)} of ${mineTotal} complete`);
  });

  it("must NOT fire: the co-assignee's copy of the same task stays pending", async () => {
    await createManual("Confirm participation", fixture.speakerIds.slice(0, 2));
    const before = await load();
    const created = (personId: string) =>
      before.rows.find((row) => row.title === "Confirm participation" && row.personId === personId)!;
    const mine = created(fixture.speakerIds[0]);
    const theirs = created(fixture.speakerIds[1]);
    // The seed ships its own completed tasks, so the expected set is derived,
    // not hardcoded — but it is still an exact set, not a count.
    const completeBefore = (await load("?status=complete")).rows.map((row) => row.id);

    await portalComplete(fixture.speakerIds[0], mine.id);

    const after = await load();
    const untouched = after.rows.find((row) => row.id === theirs.id)!;
    expect(untouched.status).toBe("pending");
    expect(untouched.completedAt).toBeNull();
    expect((await load("?status=complete")).rows.map((row) => row.id).sort()).toEqual(
      [...completeBefore, mine.id].sort(),
    );
  });
});
