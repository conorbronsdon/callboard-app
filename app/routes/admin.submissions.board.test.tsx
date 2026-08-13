import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessions } from "~/db/schema";
import { STATUS_TABS } from "~/lib/review/pipeline";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  SUBMISSIONS,
  type DemoFixture,
} from "~/test/fixtures";

import AdminSubmissionsBoard, {
  action,
  loader,
} from "./admin.submissions.board";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

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

async function load(url = "https://x.test/admin/submissions/board") {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}

async function post(fields: Record<string, string>) {
  const request = await signedInPost(
    "https://x.test/admin/submissions/board",
    fixture.adminId,
    fields,
  );
  return action(asActionArgs(request));
}

async function statusOf(id: string) {
  return (await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) }))
    ?.status;
}

describe("submissions board route", () => {
  it("groups every seeded abstract into the seven status columns and renders the board", async () => {
    const data = await load();
    expect(data.columns.map((column) => column.status)).toEqual(
      STATUS_TABS.map((tab) => tab.status),
    );

    for (const [index, [title, status]] of SUBMISSIONS.entries()) {
      const matchingColumn = data.columns.find(
        (column) => column.status === status,
      );
      expect(matchingColumn?.cards).toContainEqual(
        expect.objectContaining({
          id: fixture.abstractIds[index],
          title,
          status,
        }),
      );
    }

    const props = {
      loaderData: data,
      actionData: undefined,
    } as unknown as Parameters<typeof AdminSubmissionsBoard>[0];
    const html = renderToStaticMarkup(<AdminSubmissionsBoard {...props} />);
    expect(html).toContain('data-testid="submissions-board"');
    expect(html).toContain("Cost modelling for multi-agent systems");
    expect(html).toContain('aria-current="page"');
  });

  it("returns and renders all seven empty columns for an event with zero abstracts", async () => {
    const emptyEventId = "99999999-9999-4999-8999-999999999999";
    await ctx.db.insert(events).values({
      id: emptyEventId,
      name: "Empty event",
      slug: "empty-event",
      timezone: "UTC",
    });

    const data = await load(
      "https://x.test/admin/submissions/board?event=empty-event",
    );
    expect(data.event).toMatchObject({ id: emptyEventId, name: "Empty event" });
    expect(data.columns).toHaveLength(7);
    expect(data.columns.every((column) => column.cards.length === 0)).toBe(
      true,
    );

    const props = {
      loaderData: data,
      actionData: undefined,
    } as unknown as Parameters<typeof AdminSubmissionsBoard>[0];
    const html = renderToStaticMarkup(<AdminSubmissionsBoard {...props} />);
    for (const tab of STATUS_TABS) {
      expect(html).toContain(
        `data-testid="submissions-board-column-${tab.status}"`,
      );
    }
  });

  it("MUST FIRE: moves a current-event abstract through applyAbstractStatus", async () => {
    const sessionId = fixture.abstractIds[3];
    expect(await statusOf(sessionId)).toBe("pending");

    const result = await post({
      intent: "set-status",
      sessionId,
      status: "accept_queue",
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toContain(
      "/admin/submissions/board?notice=",
    );
    expect(await statusOf(sessionId)).toBe("accept_queue");
  });

  it("MUST NOT FIRE: rejects a non-admin-assignable status without changing the row", async () => {
    const sessionId = fixture.abstractIds[3];
    const before = await statusOf(sessionId);

    const result = await post({
      intent: "set-status",
      sessionId,
      status: "draft",
    });

    expect(result).toMatchObject({ ok: false });
    expect(await statusOf(sessionId)).toBe(before);
  });

  it("MUST NOT FIRE: rejects a cross-event abstract without changing the row", async () => {
    const otherEventId = "88888888-8888-4888-8888-888888888888";
    const otherSessionId = "77777777-7777-4777-8777-777777777777";
    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other event",
      slug: "other-event",
      timezone: "UTC",
      createdAt: new Date(Date.now() + 86_400_000),
    });
    await ctx.db.insert(sessions).values({
      id: otherSessionId,
      eventId: otherEventId,
      title: "Other event abstract",
      status: "pending",
      isAbstract: true,
    });

    const result = await post({
      intent: "set-status",
      sessionId: otherSessionId,
      status: "accept_queue",
    });

    expect(result).toMatchObject({ ok: false });
    expect(await statusOf(otherSessionId)).toBe("pending");
  });
});
