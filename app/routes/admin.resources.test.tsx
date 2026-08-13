import { and, asc, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, resources } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminResources, { ResourcesView, action, loader } from "./admin.resources";
import { loader as portalResourceLoader } from "./portal.resource";
import { loader as portalResourcesLoader } from "./portal.resources";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type PortalDetailArgs = Parameters<typeof portalResourceLoader>[0];
type PortalListArgs = Parameters<typeof portalResourcesLoader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load() {
  const request = await signedInGet("https://x.test/admin/resources", fixture.adminId);
  return loader({ request, params: {}, context: {} } as unknown as LoaderArgs);
}

async function post(fields: Record<string, string>) {
  const request = await signedInPost(
    "https://x.test/admin/resources",
    fixture.adminId,
    fields,
  );
  return action({ request, params: {}, context: {} } as unknown as ActionArgs);
}

async function addPage(overrides: Partial<typeof resources.$inferInsert> = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await ctx.db.insert(resources).values({
    id,
    eventId: fixture.eventId,
    slug: `page-${id.slice(0, 6)}`,
    title: "Resource page",
    order: 0,
    ...overrides,
  });
  return id;
}

describe("resource organizer loader and rendering", () => {
  it("renders the zero state for an event with no pages", async () => {
    const data = await load();
    expect(data.pages).toEqual([]);
    expect(renderToStaticMarkup(<ResourcesView {...data} />)).toContain(
      'data-testid="resources-zero"',
    );
  });

  it("renders the no-event state without exposing an editor", () => {
    const html = renderToStaticMarkup(<ResourcesView event={null} pages={[]} />);
    expect(html).toContain('data-testid="resources-empty-event"');
    expect(html).not.toContain('name="htmlEmbed"');
  });

  it("renders editable seeded rows and only sanitizer-produced preview HTML", async () => {
    const id = await addPage({
      slug: "arrival",
      title: "Arrival guide",
      body: "## Doors\nUse the east entrance.",
      htmlEmbed: '<div onclick="steal()">Safe</div><script>alert(1)</script>',
      isPublished: true,
    });

    const data = await load();
    const page = data.pages[0];
    expect(page.preview.bodyHtml).toContain("<h2>Doors</h2>");
    expect(page.preview.embedHtml).not.toContain("<script");
    expect(page.preview.embedHtml).not.toContain("onclick");
    expect(page.preview.removed.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<ResourcesView {...data} />);
    expect(html).toContain(`data-testid="resource-preview-${id}"`);
    expect(html).toContain("Arrival guide");
    expect(html).toContain("Archive");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("the route default export renders its loader data", async () => {
    const props = { loaderData: await load(), actionData: undefined } as unknown as Parameters<
      typeof AdminResources
    >[0];
    expect(renderToStaticMarkup(<AdminResources {...props} />)).toContain(
      'data-testid="admin-resources"',
    );
  });
});

describe("resource organizer actions", () => {
  it("creates a private page with a friendly slug and the next order", async () => {
    await addPage({ slug: "first", title: "First", order: 4 });
    const response = await post({
      intent: "create",
      title: "  Speaker Arrival & AV  ",
      slug: "",
      body: "Bring slides.",
      htmlEmbed: "",
    });

    expect((response as Response).status).toBe(302);
    const created = await ctx.db.query.resources.findFirst({
      where: and(
        eq(resources.eventId, fixture.eventId),
        eq(resources.slug, "speaker-arrival-av"),
      ),
    });
    expect(created).toMatchObject({
      title: "Speaker Arrival & AV",
      isPublished: false,
      order: 5,
    });
  });

  it("MUST-FIRE: refuses an empty title and duplicate event slug", async () => {
    await addPage({ slug: "handbook" });
    expect(await post({ intent: "create", title: " ", slug: "" })).toEqual({
      ok: false,
      error: "A title is required and must be 120 characters or fewer.",
    });
    expect(await post({ intent: "create", title: "Other", slug: "handbook" })).toEqual({
      ok: false,
      error: "Another resource in this event already uses that URL slug.",
    });
  });

  it("MUST-NOT-FIRE: allows the same slug in another event", async () => {
    const otherEventId = crypto.randomUUID();
    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other event",
      slug: "other-event",
      timezone: "UTC",
    });
    await ctx.db.insert(resources).values({
      id: crypto.randomUUID(),
      eventId: otherEventId,
      slug: "handbook",
      title: "Other handbook",
    });

    const response = await post({ intent: "create", title: "Our handbook", slug: "handbook" });
    expect((response as Response).status).toBe(302);
    expect(
      await ctx.db.query.resources.findFirst({
        where: and(
          eq(resources.eventId, fixture.eventId),
          eq(resources.slug, "handbook"),
        ),
      }),
    ).toBeTruthy();
  });

  it("edits source content while the loader keeps the preview sanitized", async () => {
    const id = await addPage({ slug: "old", title: "Old" });
    await post({
      intent: "save",
      resourceId: id,
      title: "New title",
      slug: "new-title",
      body: "# Updated",
      htmlEmbed: '<p onclick="bad()">Still here</p>',
    });

    const stored = await ctx.db.query.resources.findFirst({ where: eq(resources.id, id) });
    expect(stored).toMatchObject({
      title: "New title",
      slug: "new-title",
      body: "# Updated",
      htmlEmbed: '<p onclick="bad()">Still here</p>',
    });
    const page = (await load()).pages[0];
    expect(page.preview.embedHtml).not.toContain("onclick");
    expect(page.preview.embedHtml).toContain("Still here");
  });

  it("moves pages one position and preserves the speaker-facing order", async () => {
    const firstId = await addPage({ slug: "first", title: "First", order: 0 });
    await addPage({ slug: "second", title: "Second", order: 1 });
    await addPage({ slug: "third", title: "Third", order: 2 });

    await post({ intent: "move-down", resourceId: firstId });

    expect((await load()).pages.map((page) => page.title)).toEqual([
      "Second",
      "First",
      "Third",
    ]);
    const portalRequest = await signedInGet(
      "https://x.test/portal/resources",
      fixture.speakerIds[0],
    );
    await ctx.db
      .update(resources)
      .set({ isPublished: true })
      .where(eq(resources.eventId, fixture.eventId));
    const portal = await portalResourcesLoader({
      request: portalRequest,
      params: {},
      context: {},
    } as unknown as PortalListArgs);
    expect(portal.pages.map((page) => page.title)).toEqual(["Second", "First", "Third"]);
  });

  it("publishes and recoverably archives through the existing speaker reader", async () => {
    const id = await addPage({ slug: "speaker-guide", title: "Speaker guide" });
    const speakerRequest = () =>
      signedInGet("https://x.test/portal/resources", fixture.speakerIds[0]);

    expect(
      (
        await portalResourcesLoader({
          request: await speakerRequest(),
          params: {},
          context: {},
        } as unknown as PortalListArgs)
      ).pages,
    ).toEqual([]);

    await post({ intent: "publish", resourceId: id });
    expect(
      (
        await portalResourcesLoader({
          request: await speakerRequest(),
          params: {},
          context: {},
        } as unknown as PortalListArgs)
      ).pages.map((page) => page.slug),
    ).toEqual(["speaker-guide"]);

    await post({ intent: "archive", resourceId: id });
    expect(
      (
        await portalResourcesLoader({
          request: await speakerRequest(),
          params: {},
          context: {},
        } as unknown as PortalListArgs)
      ).pages,
    ).toEqual([]);
    expect(await ctx.db.query.resources.findFirst({ where: eq(resources.id, id) })).toMatchObject({
      isPublished: false,
      title: "Speaker guide",
    });
  });

  it("MUST-FIRE: blocks edits, archive and ordering against another event", async () => {
    const otherEventId = crypto.randomUUID();
    const foreignId = crypto.randomUUID();
    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other event",
      slug: "other-event",
      timezone: "UTC",
    });
    await ctx.db.insert(resources).values({
      id: foreignId,
      eventId: otherEventId,
      slug: "private",
      title: "Foreign resource",
      isPublished: true,
    });

    for (const intent of ["archive", "move-up"]) {
      expect(await post({ intent, resourceId: foreignId })).toEqual({
        ok: false,
        error: "That resource does not belong to this event.",
      });
    }
    expect(
      await post({
        intent: "save",
        resourceId: foreignId,
        title: "Stolen",
        slug: "stolen",
      }),
    ).toEqual({
      ok: false,
      error: "That resource does not belong to this event.",
    });
    expect(await ctx.db.query.resources.findFirst({ where: eq(resources.id, foreignId) })).toMatchObject({
      title: "Foreign resource",
      slug: "private",
      isPublished: true,
    });
  });

  it("published detail sanitizes hostile HTML on every read", async () => {
    await addPage({
      slug: "safety",
      title: "Safety",
      isPublished: true,
      body: "# Hello",
      htmlEmbed: '<div onclick="bad()">Welcome</div><script>alert(1)</script>',
    });
    const request = await signedInGet(
      "https://x.test/portal/resources/safety",
      fixture.speakerIds[0],
    );
    const data = await portalResourceLoader({
      request,
      params: { slug: "safety" },
      context: {},
    } as unknown as PortalDetailArgs);

    expect(data.page.bodyHtml).toContain("<h1>Hello</h1>");
    expect(data.page.embedHtml).toContain("Welcome");
    expect(data.page.embedHtml).not.toContain("<script");
    expect(data.page.embedHtml).not.toContain("onclick");
    expect(data.page.removed.length).toBeGreaterThan(0);
  });
});
