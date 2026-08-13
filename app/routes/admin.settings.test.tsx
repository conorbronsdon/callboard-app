import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminSettings, { loader } from "./admin.settings";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const loaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(): Promise<LoaderData> {
  return loader(
    loaderArgs(await signedInGet("https://x.test/admin/settings", fixture.adminId)),
  );
}

function markup(data: LoaderData): string {
  const Stub = createRoutesStub([
    {
      path: "/admin/settings",
      Component: () =>
        AdminSettings({ loaderData: data } as unknown as Parameters<typeof AdminSettings>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/admin/settings"]} />);
}

describe("admin settings embed grab", () => {
  it("requires an admin session", async () => {
    await expect(
      loader(loaderArgs(new Request("https://x.test/admin/settings"))),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("MUST FIRE: adds embed links while the seeded settings form MUST STILL FIRE", async () => {
    const html = markup(await load());

    expect(html).toContain('href="/admin/embeds?w=schedule"');
    expect(html).toContain('href="/admin/embeds?w=speakers"');
    expect(html).toContain("Embed this event");

    expect(html).toContain('name="name" value="Frontier AI Summit 2026"');
    expect(html).toContain(`name="slug" value="${EVENT_SLUG}"`);
  });
});
