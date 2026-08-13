/**
 * The two WS7 admin screens and the public docs page, rendered for real.
 *
 * Zero state AND seeded state for each (AGENTS.md #3), plus the two properties
 * that matter about the key screen: an admin-only guard, and a plaintext key
 * that is rendered once and never persisted.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apiKeys } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminApiKeys, {
  ApiKeysScreen,
  action as keysAction,
  loader as keysLoader,
} from "./admin.apikeys";
import AdminIntegrations, {
  IntegrationsScreen,
  loader as integrationsLoader,
} from "./admin.integrations";
import { DevelopersPage, loader as developersLoader } from "./public.developers";

let ctx: TestDbContext;
let fixture: DemoFixture;

const asArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as never;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/* ------------------------------------------------------------ api keys */

describe("admin/api-keys", () => {
  async function load() {
    return keysLoader(asArgs(await signedInGet("https://x.test/admin/api-keys", fixture.adminId)));
  }

  it("403s a signed-in speaker (DECISIONS #19)", async () => {
    const request = await signedInGet("https://x.test/admin/api-keys", fixture.speakerIds[0]);
    await expect(keysLoader(asArgs(request))).rejects.toMatchObject({ status: 403 });
  });

  it("renders the zero state", async () => {
    const data = await load();
    expect(data.keys).toEqual([]);
    const html = renderToStaticMarkup(<ApiKeysScreen data={data} />);
    expect(html).toContain("data-empty-keys");
    expect(html).toContain("No API keys yet");
  });

  it("mints a key, shows it ONCE, and never stores the plaintext", async () => {
    const request = await signedInPost(
      "https://x.test/admin/api-keys",
      fixture.adminId,
      { intent: "mint", name: "Accelevents sync", preset: "read_only" },
    );
    const result = await keysAction(asArgs(request));
    expect(result.ok).toBe(true);

    const plaintext = result.minted!.plaintext;
    expect(plaintext.startsWith("cb_")).toBe(true);
    expect(result.minted!.scopes).toEqual([
      "read:events",
      "read:sessions",
      "read:contacts",
      "read:metadata",
    ]);

    // The value appears in the response the admin sees…
    const html = renderToStaticMarkup(
      <ApiKeysScreen data={await load()} result={result} />,
    );
    expect(html).toContain("data-minted-key");
    expect(html).toContain(plaintext);

    // …and nowhere in the database.
    const [row] = await ctx.db.select().from(apiKeys);
    expect(row.keyHash).not.toBe(plaintext);
    expect(row.keyHash).toHaveLength(64);
    expect(row.keySuffix).toBe(plaintext.slice(-4));
    const dump = JSON.stringify(await ctx.db.select().from(apiKeys));
    expect(dump).not.toContain(plaintext);

    // A later page load cannot show it again.
    const later = renderToStaticMarkup(<ApiKeysScreen data={await load()} />);
    expect(later).not.toContain(plaintext);
    expect(later).toContain("…" + plaintext.slice(-4));
  });

  it("rejects a mint with no name and one with no scopes", async () => {
    const noName = await keysAction(
      asArgs(
        await signedInPost("https://x.test/admin/api-keys", fixture.adminId, {
          intent: "mint",
          name: "  ",
          preset: "read_only",
        }),
      ),
    );
    expect(noName.ok).toBe(false);

    const noScopes = await keysAction(
      asArgs(
        await signedInPost("https://x.test/admin/api-keys", fixture.adminId, {
          intent: "mint",
          name: "Custom",
          preset: "",
        }),
      ),
    );
    expect(noScopes.ok).toBe(false);
    expect(noScopes.error).toContain("scope");
  });

  it("revokes, and refuses to revoke twice", async () => {
    const minted = await keysAction(
      asArgs(
        await signedInPost("https://x.test/admin/api-keys", fixture.adminId, {
          intent: "mint",
          name: "Temp",
          preset: "read_write",
        }),
      ),
    );
    expect(minted.ok).toBe(true);
    const [row] = await ctx.db.select().from(apiKeys);

    const revoke = async () =>
      keysAction(
        asArgs(
          await signedInPost("https://x.test/admin/api-keys", fixture.adminId, {
            intent: "revoke",
            keyId: row.id,
          }),
        ),
      );

    expect((await revoke()).ok).toBe(true);
    expect((await revoke()).ok).toBe(false);

    const html = renderToStaticMarkup(<ApiKeysScreen data={await load()} />);
    expect(html).toContain("revoked");
  });

  it("renders through the default export with loader data", async () => {
    await keysAction(
      asArgs(
        await signedInPost("https://x.test/admin/api-keys", fixture.adminId, {
          intent: "mint",
          name: "Listed key",
          preset: "read_only",
        }),
      ),
    );
    const html = renderToStaticMarkup(
      <AdminApiKeys
        {...({ loaderData: await load(), actionData: undefined } as unknown as Parameters<
          typeof AdminApiKeys
        >[0])}
      />,
    );
    expect(html).toContain("Listed key");
  });
});

/* -------------------------------------------------------- integrations */

describe("admin/integrations", () => {
  async function load() {
    return integrationsLoader(
      asArgs(await signedInGet("https://x.test/admin/integrations", fixture.adminId)),
    );
  }

  it("403s a signed-in speaker", async () => {
    const request = await signedInGet("https://x.test/admin/integrations", fixture.speakerIds[0]);
    await expect(integrationsLoader(asArgs(request))).rejects.toMatchObject({ status: 403 });
  });

  it("renders the unconfigured state for BOTH providers, honestly", async () => {
    const data = await load();
    expect(data.accelevents.apiConfigured).toBe(false);
    expect(data.airtable.configured).toBe(false);

    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("data-airtable-unconfigured");
    expect(html).toContain("AIRTABLE_TOKEN");
    // The CSV pair is available regardless — it is the complete path.
    expect(html).toContain("accelevents.csv?file=speakers");
    expect(html).toContain("accelevents.csv?file=sessions");
    // And the API limitation is stated, not buried.
    expect(html).toContain("cannot link a speaker to a session");
    expect(html).toContain("No sync history yet");
  });

  it("counts the CSV rows from real data", async () => {
    const data = await load();
    expect(data.accelevents.speakerRows).toBe(2);
    expect(data.accelevents.sessionRows).toBe(2);
    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("speakers.csv (2 rows)");
    expect(html).toContain("sessions.csv (2 rows)");
  });

  it("shows the configured state when the env vars exist", async () => {
    ctx.close();
    ctx = installTestDb({
      AIRTABLE_TOKEN: "pat",
      AIRTABLE_BASE: "appX",
      ACCELEVENTS_API_KEY: "k",
      ACCELEVENTS_EVENT_URL: "slug",
    });
    fixture = await seedDemoFixture(ctx.db);

    const data = await load();
    expect(data.airtable.configured).toBe(true);
    expect(data.accelevents.apiConfigured).toBe(true);

    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("CSV pair + API push");
    expect(html).not.toContain("data-airtable-unconfigured");
    expect(html).toContain("a key is configured here");
  });

  it("renders the zero state when no event exists at all", async () => {
    ctx.close();
    ctx = installTestDb();
    const [admin] = await ctx.db
      .insert((await import("~/db/schema")).people)
      .values({ email: "solo@callboard.dev", role: "admin" })
      .returning();

    const data = await integrationsLoader(
      asArgs(await signedInGet("https://x.test/admin/integrations", admin.id)),
    );
    expect(data.event).toBeNull();
    const html = renderToStaticMarkup(<IntegrationsScreen data={data} />);
    expect(html).toContain("Create one in Settings first.");
  });

  it("renders through the default export", async () => {
    const html = renderToStaticMarkup(
      <AdminIntegrations
        {...({ loaderData: await load(), actionData: undefined } as unknown as Parameters<
          typeof AdminIntegrations
        >[0])}
      />,
    );
    expect(html).toContain("Sync to Accelevents");
  });
});

/* ----------------------------------------------------------- /developers */

describe("/developers", () => {
  it("lists every catalogued endpoint with a copy-pasteable curl", async () => {
    const data = await developersLoader(
      asArgs(new Request("https://callboard.test/developers")),
    );
    expect(data.eventId).toBe(fixture.eventId);

    const html = renderToStaticMarkup(<DevelopersPage {...data} />);
    const { API_OPERATIONS } = await import("~/lib/api/catalogue");
    for (const operation of API_OPERATIONS) {
      expect(html, operation.operationId).toContain(`data-operation="${operation.operationId}"`);
    }
    expect(html).toContain("x-access-token");
    expect(html).toContain("/v1/openapi.json");
    // The examples point at a REAL event id from this deployment.
    expect(html).toContain(fixture.eventId);
  });

  it("renders with no event at all, using a placeholder id", async () => {
    ctx.close();
    ctx = installTestDb();

    const data = await developersLoader(
      asArgs(new Request("https://callboard.test/developers")),
    );
    expect(data.eventId).toBe("EVENT_ID");
    const html = renderToStaticMarkup(<DevelopersPage {...data} />);
    expect(html).toContain("EVENT_ID");
  });

  it("needs no API key to read — docs behind auth are docs nobody evaluates", async () => {
    const data = await developersLoader(
      asArgs(new Request("https://callboard.test/developers")),
    );
    expect(data.origin).toBe("https://callboard.test");
  });
});
