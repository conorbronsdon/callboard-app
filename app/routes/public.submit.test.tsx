import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_SLUG, seedDemoFixture } from "~/test/fixtures";

import PublicSubmitWelcome, { loader } from "./public.submit";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb();
  await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function renderWelcome(body: string): Promise<string> {
  await ctx.db.update(forms).set({ welcomeBody: body }).where(eq(forms.id, CFP_FORM_ID));
  const data = await loader({
    request: new Request(`https://x.test/submit/${EVENT_SLUG}/${CFP_FORM_ID}`),
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID },
    context: {},
  } as unknown as LoaderArgs);
  const props = { loaderData: data } as unknown as Parameters<typeof PublicSubmitWelcome>[0];
  return renderToStaticMarkup(
    <MemoryRouter>
      <PublicSubmitWelcome {...props} />
    </MemoryRouter>,
  );
}

describe("public CFP welcome copy", () => {
  it("MUST FIRE: strips scripts and event handlers before rich welcome copy renders", async () => {
    const html = await renderWelcome(
      '<p onclick="steal()">Welcome <strong>speaker</strong>.</p>' +
        '<script>steal()</script><a href="https://example.com/guide">Read the guide</a>',
    );

    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("steal()");
  });

  it("MUST NOT FIRE: preserves safe formatting and links in welcome copy", async () => {
    const html = await renderWelcome(
      '<p>Welcome <strong>speaker</strong>.</p><a href="https://example.com/guide">Read the guide</a>',
    );

    expect(html).toContain("<strong>speaker</strong>");
    expect(html).toContain('href="https://example.com/guide"');
  });

  it("keeps the existing paragraph fallback when welcome copy has no markup", async () => {
    const html = await renderWelcome("First paragraph.\n\nSecond paragraph.");

    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });
});
