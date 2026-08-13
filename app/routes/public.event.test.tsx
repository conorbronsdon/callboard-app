/**
 * Open-call cards on the public event page.
 *
 * The defect pinned here is invisible on the shipped seed, which is exactly why
 * it needed a test rather than a look: the Frontier AI Summit has two open calls with
 * DIFFERENT targets ("Call for Proposals 2026" is `submission`, "Sponsor
 * session intake" is `session`), so their CTA labels already read differently.
 * Add a second call with the SAME target and both links collapse onto one
 * accessible name — "Submit an abstract" — pointing at two different forms.
 * That is WCAG 2.4.4, and a screen reader's link list does not carry the
 * surrounding card text that makes them distinguishable on screen.
 *
 * The fixture below builds that second same-target call, so this file fails
 * against the pre-fix component instead of documenting a case nothing reaches.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture } from "~/test/fixtures";

import { loader } from "./public.event";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const SECOND_CALL_NAME = "Sponsor track call";

const asLoaderArgs = (slug: string) =>
  ({
    request: new Request(`https://x.test/e/${slug}`),
    params: { slug },
    context: {},
  }) as unknown as LoaderArgs;

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb();
  await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const load = (slug = EVENT_SLUG): Promise<LoaderData> => loader(asLoaderArgs(slug));

/** A second OPEN cfp call on the same event, with the same target as the seeded one. */
async function addSameTargetCall(name = SECOND_CALL_NAME) {
  await ctx.db.insert(forms).values({
    eventId: EVENT_ID,
    name,
    target: "submission",
    surface: "cfp",
    status: "open",
    schema: { version: 1, fields: [] },
  });
}

interface RenderedLink {
  href: string;
  visibleText: string;
  accessibleName: string;
}

/**
 * Accessible name, computed the way a screen reader does for these links:
 * `aria-label` wins over the element's text, and nothing outside the element
 * contributes. Deliberately not a substring check on the markup — a substring
 * would pass on a page that emitted the right label on the wrong link.
 */
function submitLinks(markup: string): RenderedLink[] {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map(([, attrs, inner]) => {
      const visibleText = inner.replace(/<[^>]*>/g, "").trim();
      return {
        href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "",
        visibleText,
        accessibleName: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? visibleText,
      };
    })
    .filter((link) => link.href.includes("/submit/"));
}

/** The page uses `Shell`, whose NavLink needs a router — stub one. */
async function markupFor(data: LoaderData): Promise<string> {
  const { default: PublicEvent } = await import("./public.event");
  const Stub = createRoutesStub([
    {
      path: "/e/:slug",
      Component: () =>
        PublicEvent({ loaderData: data } as unknown as Parameters<typeof PublicEvent>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={[`/e/${EVENT_SLUG}`]} />);
}

/** The doorway link's rendered `<a>`, if any — same extraction as shell.test.tsx. */
function organizersLink(markup: string): { attrs: string; text: string } | null {
  const match = /<a\b([^>]*data-testid="public-organizers-link"[^>]*)>([\s\S]*?)<\/a>/.exec(
    markup,
  );
  if (!match) return null;
  return { attrs: match[1], text: match[2].replace(/<[^>]*>/g, "").trim() };
}

describe("the Organizers doorway link", () => {
  it("MUST FIRE: pinned in the public event nav, pointing at /admin outside demo mode", async () => {
    const markup = await markupFor(await load());
    const link = organizersLink(markup);
    expect(link).not.toBeNull();
    expect(link!.text).toBe("Organizers →");
    expect(link!.attrs).toContain('href="/admin"');
  });

  it("MUST FIRE: switches target to /demo on a live disposable demo deployment", async () => {
    ctx.close();
    ctx = installTestDb({
      DEPLOYMENT_PROFILE: "demo",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });
    await seedDemoFixture(ctx.db);

    const markup = await markupFor(await load());
    expect(organizersLink(markup)!.attrs).toContain('href="/demo"');
  });
});

describe("open-call CTAs", () => {
  it("MUST FIRE: two calls with the same target get distinct accessible names", async () => {
    await addSameTargetCall();

    const links = submitLinks(await markupFor(await load()));

    expect(links).toHaveLength(2);
    // Different destinations...
    expect(new Set(links.map((link) => link.href)).size).toBe(2);
    // ...must not share one name. This is the assertion that goes red pre-fix.
    expect(new Set(links.map((link) => link.accessibleName)).size).toBe(2);
    expect(links.map((link) => link.accessibleName).sort()).toEqual([
      "Submit an abstract — Call for Proposals 2026",
      `Submit an abstract — ${SECOND_CALL_NAME}`,
    ]);
  });

  it("MUST NOT FIRE: the visible label is still the short imperative", async () => {
    await addSameTargetCall();

    const links = submitLinks(await markupFor(await load()));

    // The fix adds to the accessible name; it must not put the call's name on
    // screen, and must not disturb the label the brief's §6 register freezes.
    expect(links.map((link) => link.visibleText)).toEqual([
      "Submit an abstract",
      "Submit an abstract",
    ]);
    // "click Submit an abstract" still matches: the visible text remains the
    // start of the accessible name, per WCAG 2.5.3 Label in Name.
    for (const link of links) {
      expect(link.accessibleName.startsWith(link.visibleText)).toBe(true);
    }
  });

  it("names the single seeded call too, not just the ambiguous case", async () => {
    const links = submitLinks(await markupFor(await load()));

    expect(links).toHaveLength(1);
    expect(links[0].accessibleName).toBe("Submit an abstract — Call for Proposals 2026");
  });
});
