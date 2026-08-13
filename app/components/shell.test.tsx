/**
 * `organizersHref` — the quiet doorway to the admin surface that the five
 * public event pages (public.event, public.schedule, public.speakers,
 * public.session, public.speaker) pass into Shell.
 *
 * Two-sided on purpose: it must render, in the right place, with the right
 * target, when a route opts in — and every OTHER Shell caller (admin chrome,
 * portal, auth pages, none of which pass `organizersHref`) must be completely
 * unaffected, since Shell is shared chrome and a mistake here would leak a
 * public "Organizers" doorway onto the admin's own nav or the login page.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { Shell } from "./shell";

const PUBLIC_NAV = [
  { to: "/e/demo-event", label: "Overview", end: true },
  { to: "/e/demo-event/schedule", label: "Schedule" },
  { to: "/e/demo-event/speakers", label: "Speakers" },
];

function markupFor(props: Parameters<typeof Shell>[0]): string {
  const Stub = createRoutesStub([
    { path: "/e/demo-event", Component: () => <Shell {...props} /> },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/e/demo-event"]} />);
}

/** The rendered `<a>` for the organizers doorway, if any. */
function organizersLink(html: string): { attrs: string; text: string } | null {
  const match = /<a\b([^>]*data-testid="public-organizers-link"[^>]*)>([\s\S]*?)<\/a>/.exec(html);
  if (!match) return null;
  return { attrs: match[1], text: match[2].replace(/<[^>]*>/g, "").trim() };
}

describe("Shell — organizersHref", () => {
  it("MUST FIRE: renders the doorway link with the given target when a route opts in", () => {
    const html = markupFor({
      title: "Frontier AI Summit",
      nav: PUBLIC_NAV,
      organizersHref: "/admin",
      children: <p>content</p>,
    });
    const link = organizersLink(html);
    expect(link).not.toBeNull();
    expect(link!.attrs).toContain('href="/admin"');
    expect(link!.text).toBe("Organizers →");
  });

  it("MUST FIRE: switches target to /demo when the loader resolves the demo-mode href", () => {
    const html = markupFor({
      title: "Frontier AI Summit",
      nav: PUBLIC_NAV,
      organizersHref: "/demo",
      children: <p>content</p>,
    });
    expect(organizersLink(html)!.attrs).toContain('href="/demo"');
  });

  it("MUST NOT FIRE: absent entirely when a caller does not pass organizersHref", () => {
    // Every non-public Shell caller (admin.layout.tsx, portal chrome, /login,
    // /demo itself) falls in this bucket. Regression guard: a doorway link
    // must never leak onto the admin's own nav or the login page.
    const html = markupFor({
      title: "Admin",
      nav: PUBLIC_NAV,
      children: <p>content</p>,
    });
    expect(organizersLink(html)).toBeNull();
    expect(html).not.toContain("Organizers");
  });

  it("MUST NOT FIRE: does not reuse the active-tab pill styling — it is a doorway, not a tab", () => {
    const html = markupFor({
      title: "Frontier AI Summit",
      nav: PUBLIC_NAV,
      organizersHref: "/admin",
      children: <p>content</p>,
    });
    const link = organizersLink(html)!;
    // navLinkClass's tab treatment (bg-blue-100 / font-semibold / shadow-…) is
    // the one styling authority for the three real tabs; the doorway must not
    // borrow it, or it reads as a fourth destination on this event rather
    // than an exit to a different surface.
    expect(link.attrs).not.toContain("bg-blue-100");
    expect(link.attrs).not.toContain("font-semibold");
    // Right-aligned in the same flex strip as the tabs, and visually muted.
    expect(link.attrs).toContain("ml-auto");
    expect(link.attrs).toContain("text-gray-400");
  });

  it("MUST NOT FIRE: the nav strip renders none of the three tabs' styling change when organizersHref is present", () => {
    // Adding the doorway link must not disturb the existing tabs' own markup.
    const withDoorway = markupFor({
      title: "Frontier AI Summit",
      nav: PUBLIC_NAV,
      organizersHref: "/admin",
      children: <p>content</p>,
    });
    const withoutDoorway = markupFor({
      title: "Frontier AI Summit",
      nav: PUBLIC_NAV,
      children: <p>content</p>,
    });
    for (const label of ["Overview", "Schedule", "Speakers"]) {
      expect(withDoorway).toContain(`>${label}</a>`);
      expect(withoutDoorway).toContain(`>${label}</a>`);
    }
  });
});
