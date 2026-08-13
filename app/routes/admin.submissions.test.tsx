/**
 * Abstracts table: loader values, action rules (must-fire AND must-not-fire),
 * and that the screen renders with zero rows and with seed rows.
 *
 * The render assertions run the REAL default export through
 * `renderToStaticMarkup` — the page is deliberately router-free so this is a
 * page render, not a snapshot of loader data.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminSubmissions, { AbstractsView, action, loader } from "./admin.submissions";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(url: string): Promise<LoaderData> {
  const request = await signedInGet(url, fixture.adminId);
  return loader(asLoaderArgs(request));
}

async function post(fields: Record<string, string>, url = "https://x.test/admin/submissions") {
  const request = await signedInPost(url, fixture.adminId, fields);
  return action(asActionArgs(request));
}

describe("loader", () => {
  it("counts all seven tabs against the seeded data", async () => {
    const data = await load("https://x.test/admin/submissions");
    const counts = Object.fromEntries(data.tabs.map((tab) => [tab.status, tab.count]));

    expect(counts).toEqual({
      accepted: 2,
      accept_queue: 1,
      pending: 2,
      decline_queue: 1,
      declined: 1,
      withdrawn: 1,
      draft: 0,
    });
    // Program sessions are NOT abstracts and must never appear in these tabs.
    expect(data.tabs.reduce((sum, tab) => sum + tab.count, 0)).toBe(8);
  });

  it("defaults to the Pending tab and returns its rows with key columns", async () => {
    const data = await load("https://x.test/admin/submissions");
    expect(data.tab).toBe("pending");
    expect(data.rows).toHaveLength(2);

    const row = data.rows.find((r) => r.title === "Cost modelling for multi-agent systems");
    expect(row).toBeDefined();
    expect(row?.speakers).toEqual(["Mira Halvorsen"]);
    expect(row?.trackName).toBe("Agents");
    expect(row?.source).toBe("Call for Proposals 2026");
    expect(row?.submittedAt).toBeTruthy();
  });

  it("filters by track — must fire and must not fire", async () => {
    const evals = fixture.trackIds[1];
    const data = await load(`https://x.test/admin/submissions?tab=pending&track=${evals}`);

    // must fire: only the pending abstract on that track survives
    expect(data.rows.map((row) => row.title)).toEqual([
      "Tool-calling failure modes, catalogued",
    ]);
    // must not fire: the other pending abstract is on a different track
    expect(data.rows.map((row) => row.title)).not.toContain(
      "Cost modelling for multi-agent systems",
    );
    // tab counts follow the filter too
    expect(data.tabs.find((tab) => tab.status === "pending")?.count).toBe(1);
  });

  it("falls back to Pending for a junk tab rather than 500ing", async () => {
    const data = await load("https://x.test/admin/submissions?tab=nonsense");
    expect(data.tab).toBe("pending");
  });

  it("reports the queue sizes the commit button needs", async () => {
    const data = await load("https://x.test/admin/submissions");
    expect(data.queue).toEqual({ accept: 1, decline: 1 });
  });
});

describe("action: set-status", () => {
  it("must fire: saving moves the row, and only on the save POST", async () => {
    const target = fixture.abstractIds[3]; // pending

    // A plain load must never mutate.
    await load("https://x.test/admin/submissions");
    let row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.status).toBe("pending");

    const response = await post({
      intent: "set-status",
      sessionId: target,
      status: "accept_queue",
      tab: "pending",
    });
    expect((response as Response).status).toBe(302);

    row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.status).toBe("accept_queue");
  });

  it("must NOT fire: withdrawn and draft are not admin-assignable", async () => {
    const target = fixture.abstractIds[3];
    for (const status of ["withdrawn", "draft", "bogus"]) {
      const result = await post({
        intent: "set-status",
        sessionId: target,
        status,
        tab: "pending",
      });
      expect(result).toMatchObject({ ok: false });
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
      expect(row?.status).toBe("pending");
    }
  });

  it("must NOT fire: an id from another event is rejected", async () => {
    const result = await post({
      intent: "set-status",
      sessionId: "not-a-real-session",
      status: "accepted",
      tab: "pending",
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("must NOT fire: a program session cannot be restatused from the abstracts table", async () => {
    const program = fixture.programSessionIds[0];
    const result = await post({
      intent: "set-status",
      sessionId: program,
      status: "declined",
      tab: "pending",
    });

    expect(result).toMatchObject({ ok: false });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, program) });
    expect(row?.status).toBe("accepted");
  });

  it("composes the programme session and tasks when the table radio accepts", async () => {
    const target = fixture.abstractIds[4];
    const response = (await post({
      intent: "set-status",
      sessionId: target,
      status: "accepted",
      tab: "pending",
    })) as Response;

    expect(response.status).toBe(302);
    const abstract = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, target),
    });
    expect(abstract?.status).toBe("accepted");
    expect(abstract?.composedIntoSessionId).toBeTruthy();

    const programme = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstract!.composedIntoSessionId!),
    });
    expect(programme).toMatchObject({
      title: abstract!.title,
      isAbstract: false,
      status: "accepted",
    });
    const { tasks } = await import("~/db/schema");
    const createdTasks = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.sessionId, programme!.id));
    expect(createdTasks.map((task) => task.title).sort()).toEqual([
      "Complete your bio",
      "Confirm your slot",
      "Submit your slides",
      "Upload a headshot",
    ]);
  });
});

describe("action: commit-queues", () => {
  it("commits both directions and leaves pending alone", async () => {
    const response = (await post({ intent: "commit-queues", tab: "pending" })) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("ca=1");
    expect(response.headers.get("location")).toContain("cd=1");

    const accepted = await load("https://x.test/admin/submissions?tab=accepted");
    const declined = await load("https://x.test/admin/submissions?tab=declined");
    const pending = await load("https://x.test/admin/submissions?tab=pending");

    expect(accepted.rows).toHaveLength(3); // 2 seeded + 1 committed
    expect(declined.rows).toHaveLength(2); // 1 seeded + 1 committed
    expect(pending.rows).toHaveLength(2); // untouched
    expect(accepted.queue).toEqual({ accept: 0, decline: 0 });
  });
});

describe("action: manual add", () => {
  it("creates an abstract that shows up in its tab", async () => {
    const response = (await post({
      intent: "create-record",
      kind: "abstract",
      title: "Manually added abstract",
      status: "pending",
      trackId: fixture.trackIds[0],
      tab: "pending",
    })) as Response;
    expect(response.status).toBe(302);

    const data = await load("https://x.test/admin/submissions?tab=pending");
    const row = data.rows.find((r) => r.title === "Manually added abstract");
    expect(row).toBeDefined();
    // Source distinguishes the escape hatch from a real CFP submission.
    expect(row?.source).toBe("Manual");
    expect(row?.friendlyId).toBe("ABS-9");
    expect(data.tabs.find((tab) => tab.status === "pending")?.count).toBe(3);
  });

  it("creates a program session that the seed-data agenda query returns", async () => {
    await post({
      intent: "create-record",
      kind: "session",
      title: "Sponsor keynote: Vectorly",
      roomId: fixture.roomIds[0],
      startsAt: "2026-10-07T09:00",
      endsAt: "2026-10-07T09:30",
      capacity: "500",
      tab: "pending",
    });

    // Same predicate the agenda/public schedule uses: program rows with times.
    const agenda = await ctx.db
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, fixture.eventId));
    const created = agenda.find((row) => row.title === "Sponsor keynote: Vectorly");

    expect(created).toBeDefined();
    expect(created?.isAbstract).toBe(false);
    expect(created?.status).toBe("accepted");
    expect(created?.roomId).toBe(fixture.roomIds[0]);
    expect(created?.startsAt).toBeInstanceOf(Date);
    expect(created?.capacity).toBe(500);
    expect(created?.friendlyId).toBe("SESS-3");

    // …and it must NOT leak into the abstracts table.
    const data = await load("https://x.test/admin/submissions?tab=accepted");
    expect(data.rows.map((row) => row.title)).not.toContain("Sponsor keynote: Vectorly");
  });

  it("rejects a blank title", async () => {
    const result = await post({ intent: "create-record", kind: "abstract", title: "   " });
    expect(result).toMatchObject({ ok: false, error: "Title is required." });
  });

  it("rejects an unknown intent", async () => {
    expect(await post({ intent: "delete-everything" })).toMatchObject({ ok: false });
  });
});

describe("render", () => {
  it("renders the seeded state with rows, tabs and the popover", async () => {
    const data = await load("https://x.test/admin/submissions");
    const props = { loaderData: data, actionData: undefined } as unknown as Parameters<
      typeof AdminSubmissions
    >[0];
    const html = renderToStaticMarkup(<AdminSubmissions {...props} />);

    expect(html).toContain("Abstracts");
    expect(html).toContain("Cost modelling for multi-agent systems");
    expect(html).toContain("Mira Halvorsen");
    // all seven tabs, by label
    for (const label of [
      "Accepted",
      "Accept Queue",
      "Pending",
      "Decline Queue",
      "Declined",
      "Withdrawn",
      "Drafts",
    ]) {
      expect(html).toContain(label);
    }
    // popover commits explicitly
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain("+ Add Abstract");
    expect(html).toContain("+ Add Session");
    expect(html).toContain("Commit queues (1 accept / 1 decline)");
    expect(html).not.toContain("No abstracts in");
  });

  it("renders the zero state for a tab with no rows", async () => {
    const data = await load("https://x.test/admin/submissions?tab=draft");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);

    expect(html).toContain("No abstracts in Drafts yet.");
    expect(html).toContain("Drafts");
    expect(html).toContain("+ Add Abstract");
  });

  it("renders the zero state when no event exists at all", () => {
    const html = renderToStaticMarkup(
      <AbstractsView
        event={null}
        tab="pending"
        trackId={null}
        tabs={[]}
        rows={[]}
        tracks={[]}
        formats={[]}
        rooms={[]}
        queue={{ accept: 0, decline: 0 }}
        notice={null}
        confirming={false}
      />,
    );
    // Product copy, not a developer instruction.
    expect(html).toContain("No event yet");
    expect(html).toContain("every abstract submitted to it lands here for review");
    expect(html).not.toContain("npm run seed");
  });
});

/*
 * Committing the queues composes program sessions and creates speaker tasks. It
 * gets a confirmation step, and the confirmation is not decorative: the POST is
 * only reachable from it.
 */
describe("commit-queues confirmation", () => {
  it("must NOT fire: the toolbar control navigates, it does not post", async () => {
    const data = await load("https://x.test/admin/submissions");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);

    expect(data.confirming).toBe(false);
    expect(html).toContain("Commit queues (1 accept / 1 decline)");
    // A link to the confirmation, not a submit button that commits on click.
    expect(html).toContain('href="/admin/submissions?tab=pending&amp;confirm=commit"');
    expect(html).not.toContain('value="commit-queues"');
    expect(html).not.toContain('data-testid="commit-confirm"');
  });

  it("must fire: ?confirm=commit renders the summary and the real submit", async () => {
    const data = await load("https://x.test/admin/submissions?confirm=commit");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);

    expect(data.confirming).toBe(true);
    expect(html).toContain("Commit 2 queued decisions?");
    // The counts, by value, not just a generic "are you sure".
    expect(html).toContain('<strong class="tabular-nums">1</strong> abstract becomes');
    expect(html).toContain("Yes, commit 2 decisions");
    expect(html).toContain('value="commit-queues"');
    // And a way out.
    expect(html).toContain("Cancel");
  });

  it("must NOT fire: an empty queue offers nothing to confirm", async () => {
    await post({ intent: "commit-queues", tab: "pending" });
    const data = await load("https://x.test/admin/submissions?confirm=commit");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);

    expect(data.queue).toEqual({ accept: 0, decline: 0 });
    expect(html).not.toContain("queued decisions?");
    expect(html).toContain("Commit queues (0 accept / 0 decline)");
  });
});

describe("status popover", () => {
  it("stays in normal flow so the table's overflow box cannot crop it", async () => {
    const data = await load("https://x.test/admin/submissions");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);

    const popover = /<form[^>]*data-testid="status-popover-[^"]*"[^>]*class="([^"]*)"/.exec(html);
    expect(popover, "the status popover should render for every row").not.toBeNull();

    const classes = popover![1];
    // `absolute` was the original bug: the wrapper's overflow-x-auto forces
    // overflow-y to auto, which cropped the options to a ~40px sliver.
    expect(classes).not.toMatch(/\babsolute\b/);
    // `fixed` escapes the crop but ignores the wrapper's horizontal scroll, so
    // at 375px it renders hundreds of px off-screen. Measured on a real page.
    expect(classes).not.toMatch(/\bfixed\b/);
    // Never wider than a 375px screen.
    expect(classes).toContain("max-w-[calc(100vw-3rem)]");
    // All five admin-assignable statuses are reachable inside it.
    expect(popover!.index).toBeGreaterThan(-1);
    const panel = html.slice(popover!.index, html.indexOf("</form>", popover!.index));
    for (const status of ["accepted", "accept_queue", "pending", "decline_queue", "declined"]) {
      expect(panel).toContain(`value="${status}"`);
    }
  });
});
