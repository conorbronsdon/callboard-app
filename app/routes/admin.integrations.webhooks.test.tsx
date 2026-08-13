import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { webhookDeliveries, webhooks } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { IntegrationsScreen, action, loader } from "./admin.integrations";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

async function load() {
  return loader({
    request: await signedInGet("https://x.test/admin/integrations", fixture.adminId),
    params: {},
    context: {},
  } as never);
}

async function post(fields: Record<string, string>) {
  return action({
    request: await signedInPost(
      "https://x.test/admin/integrations",
      fixture.adminId,
      fields,
    ),
    params: {},
    context: {},
  } as never);
}

describe("Integrations webhook card", () => {
  it("renders the zero-row built-in state", async () => {
    const data = await load();
    expect(data.webhooks).toMatchObject({ driver: "builtin", endpoints: [], deliveries: [] });
    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain('data-empty-webhooks="true"');
    expect(html).toContain('data-empty-webhook-deliveries="true"');
    expect(html).toContain("built-in delivery");
  });

  it("renders seeded endpoint and delivery rows without exposing the stored secret", async () => {
    const secret = "must-never-leave-the-loader";
    await ctx.db.insert(webhooks).values({
      id: "render-hook",
      url: "https://receiver.test/render",
      secret,
    });
    await ctx.db.insert(webhookDeliveries).values({
      webhookId: "render-hook",
      driver: "builtin",
      event: "session.created",
      resourceId: "session-rendered",
      status: "success",
      attempts: 1,
    });

    const data = await load();
    expect(JSON.stringify(data)).not.toContain(secret);
    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("https://receiver.test/render");
    expect(html).toContain("session.created");
    expect(html).toContain("session-rendered");
    expect(html).not.toContain(secret);
  });

  it("MUST FIRE for HTTP validation and MUST NOT FIRE for HTTPS creation", async () => {
    expect(await post({ intent: "webhook-create", url: "http://receiver.test/hook" }))
      .toEqual({ ok: false, message: "Webhook URLs must start with https://." });
    expect(await ctx.db.select().from(webhooks)).toEqual([]);

    const created = await post({
      intent: "webhook-create",
      url: "https://receiver.test/hook",
    });
    expect(created.ok).toBe(true);
    expect(created.mintedWebhook?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const later = await load();
    expect(JSON.stringify(later)).not.toContain(created.mintedWebhook!.secret);
  });

  it("shows Svix management only when both values are configured", async () => {
    ctx.close();
    ctx = installTestDb({ SVIX_TOKEN: "token", SVIX_APP_ID: "app_test" });
    fixture = await seedDemoFixture(ctx.db);
    const data = await load();
    expect(data.webhooks.driver).toBe("svix");
    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("Delivery is managed by Svix");
    expect(html).not.toContain('value="webhook-create"');
  });
});
