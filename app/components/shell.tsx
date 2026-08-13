/**
 * Shared layout chrome. No client JS beyond React Router's own; public pages
 * must stay fast.
 */
import { useEffect } from "react";
import { Form, Link, NavLink, useLocation, useNavigation } from "react-router";

import {
  isAdminNavGroup,
  type AdminNavEntry,
  type AdminNavLink,
} from "~/lib/admin-nav";

/**
 * The one inline-link treatment. Underline-on-hover rather than always-on:
 * a screen with eight permanent underlines reads as a wall of hyperlinks, and
 * the colour plus weight already say "this is a link" before the pointer
 * arrives. Colour is never the only signal — every use sits in running text or
 * carries its own label.
 */
export const linkClass =
  "font-medium text-blue-700 underline-offset-4 hover:underline dark:text-blue-300";

/**
 * The one eyebrow — the small caps label above a heading, on a table header row,
 * or naming a lane.
 *
 * It existed as a token (`--text-eyebrow`, app.css) but not as a class, so
 * fifteen sites hand-rolled the same four utilities and SIX of them forgot the
 * dark variant: `text-gray-500` on `dark:bg-gray-900` measures 3.67:1, under AA
 * for the 11px it is always used at. Making it one string is not tidying — it is
 * the only way the dark half can be fixed once. `design-tokens-scan.test.ts`
 * fails if a new eyebrow grows its own copy.
 *
 * Deliberately NOT `font-mono`. The rescued design-excellence WIP proposed mono
 * eyebrows; in this product mono already means machine-precise data (the
 * schedule's `tabular-nums` time column, api keys, snippets). A label is not
 * data, and mono on the four table `<thead>` rows would have re-measured
 * columns the organizer screens are laid out around.
 */
export const eyebrowClass =
  "text-eyebrow font-semibold text-gray-500 uppercase dark:text-gray-400";

function navLinkClass(isActive: boolean): string {
  return [
    "rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-colors",
    /*
     * The active state has to win against a busy organizer nav. Three signals
     * move together — a deeper fill, a heavier weight, and a solid underline —
     * while inactive labels recede so the current location is immediate.
     */
    isActive
      ? "bg-blue-100 font-semibold text-blue-800 shadow-[inset_0_-2px_0_0_var(--color-blue-600)] dark:bg-blue-950 dark:text-blue-100 dark:shadow-[inset_0_-2px_0_0_var(--color-blue-400)]"
      : "font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100",
  ].join(" ");
}

/** Match the path semantics NavLink uses for `end` and descendant routes. */
function navLinkMatchesPath(pathname: string, item: AdminNavLink): boolean {
  const itemPath = item.to.split(/[?#]/, 1)[0];
  return pathname === itemPath || (!item.end && pathname.startsWith(`${itemPath}/`));
}

export function Shell({
  title,
  titleSize = "default",
  subtitle,
  nav,
  organizersHref,
  actions,
  children,
}: {
  title: string;
  /**
   * `display` is for the three public surfaces where the title IS the page —
   * an event name deserves more than the same `text-xl` an admin sub-route
   * gets. Organizer and portal chrome stay at `default`.
   */
  titleSize?: "default" | "display";
  subtitle?: string;
  nav?: AdminNavEntry[];
  /**
   * A quiet doorway to the admin surface, rendered right-aligned in the SAME
   * strip as `nav` but deliberately NOT one of its tabs — the five public
   * event pages pass this so an organizer or judge has an obvious way in
   * without it competing with the attendee-facing Overview/Schedule/Speakers
   * links for attention. Every other Shell caller (admin, portal, auth
   * chrome) leaves this unset, so their nav strip is unchanged.
   */
  organizersHref?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const hasGroupedNav = nav?.some(isAdminNavGroup) ?? false;

  /*
   * Progressive enhancement over the native disclosure below, NOT a
   * replacement for it. `open={isGroupActive || undefined}` only tells React
   * what to render on mount/SSR — it does not "control" the element the way
   * `value`/`checked` do. A native click toggles the real DOM attribute
   * directly, React never sees it, and because this Shell lives inside a
   * layout route it does NOT remount between admin pages — only `<Outlet/>`
   * changes. So a group whose `isGroupActive` prop happens to read `false`
   * on both the render before AND after a click looks "unchanged" to React,
   * which skips writing the DOM attribute, and the user's manual open just
   * sits there forever. Explore three groups across a session and all three
   * stay open — the bug Conor found.
   *
   * This effect is the fix for the second half (state surviving navigation);
   * `name="admin-nav"` below is the fix for the first half (more than one
   * open at once) and needs no JS at all. Runs client-side only, on route
   * change, and does nothing without JavaScript — the server-rendered
   * `open` attribute above is already correct on a fresh/no-JS load, so
   * there is nothing for this effect to fix in that case.
   */
  useEffect(() => {
    if (!hasGroupedNav) return;
    for (const entry of nav ?? []) {
      if (!isAdminNavGroup(entry)) continue;
      const details = document.querySelector<HTMLDetailsElement>(
        `[data-testid="admin-nav-group-${entry.key}"]`,
      );
      if (!details) continue;
      details.open = entry.items.some((item) => navLinkMatchesPath(location.pathname, item));
    }
    // `nav` is intentionally not a dependency: its grouping is stable for the
    // life of the session (only `reviewerWorkspace`'s href varies, which does
    // not change which group is active), so re-running this on every new
    // `nav` array identity would just be extra work for the same result.
  }, [location.pathname, hasGroupedNav]);

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3.5 sm:px-6">
          <a
            href="/"
            className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100"
          >
            callboard
          </a>
          <span aria-hidden="true" className="text-gray-300 dark:text-gray-700">
            /
          </span>
          <h1
            className={
              titleSize === "display"
                ? "text-2xl font-semibold tracking-tight sm:text-3xl"
                : "text-xl font-semibold tracking-tight sm:text-2xl"
            }
          >
            {title}
          </h1>
          {/*
           * `actions` sits before the subtitle because the subtitle is a
           * full-width flex item: put it first and it takes the whole row,
           * pushing sign-out onto a third line of its own.
           */}
          <div className="ml-auto flex items-center gap-3 text-sm">{actions}</div>
          {subtitle ? (
            <p className="w-full text-sm text-gray-600 dark:text-gray-400">{subtitle}</p>
          ) : null}
        </div>
        {nav?.length ? (
          /*
           * Eight organizer controls fit by wrapping at every width, so that
           * grouped nav deliberately has no sideways strip on phones. Small
           * flat public navs keep their original scrolling wrapper unchanged.
           */
          <nav
            className={
              hasGroupedNav
                ? "mx-auto flex max-w-6xl flex-wrap items-start gap-x-1 gap-y-1 border-t border-gray-100 px-4 pt-2 pb-2.5 text-sm sm:px-6 dark:border-gray-800"
                : "mx-auto flex max-w-6xl gap-x-1 gap-y-1 overflow-x-auto border-t border-gray-100 px-4 pt-2 pb-2.5 text-sm sm:px-6 md:flex-wrap md:overflow-x-visible dark:border-gray-800"
            }
          >
            {nav.map((entry) => {
              if (!isAdminNavGroup(entry)) {
                return (
                  <NavLink
                    key={entry.to}
                    to={entry.to}
                    end={entry.end}
                    className={({ isActive }) => navLinkClass(isActive)}
                  >
                    {entry.label}
                  </NavLink>
                );
              }

              const isGroupActive = entry.items.some((item) =>
                navLinkMatchesPath(location.pathname, item),
              );
              return (
                <details
                  key={entry.key}
                  data-testid={`admin-nav-group-${entry.key}`}
                  /*
                   * A shared `name` puts every group in one exclusive
                   * accordion set: the HTML living standard requires the
                   * browser to close the others the instant any one of them
                   * opens, whether that open comes from a click or from a
                   * script setting `.open`/the attribute — no JS required,
                   * and supported in every current evergreen browser. This
                   * alone stops "several groups open at once"; the effect
                   * above stops "the wrong group is still open after I
                   * navigated away from it".
                   */
                  name="admin-nav"
                  open={isGroupActive || undefined}
                  className="group relative max-w-full"
                >
                  <summary
                    className={`${navLinkClass(isGroupActive)} inline-flex cursor-pointer list-none items-center gap-1`}
                  >
                    {entry.label}
                    <span
                      aria-hidden="true"
                      className="text-xs text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
                    >
                      ▾
                    </span>
                  </summary>
                  <div className="mt-1 grid w-52 max-w-[calc(100vw-2rem)] gap-1 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg sm:absolute sm:left-0 sm:z-20 dark:border-gray-700 dark:bg-gray-900">
                    {entry.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) => `${navLinkClass(isActive)} block`}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                </details>
              );
            })}
            {organizersHref ? (
              /*
               * Deliberately NOT `navLinkClass` — that treatment reads as a
               * fourth tab competing with Overview/Schedule/Speakers for an
               * attendee's attention. `ml-auto` pushes it to the far end of
               * the same strip; muted colour and a thin arrow mark it as a
               * doorway to a different audience, not another page of this one.
               */
              <Link
                to={organizersHref}
                data-testid="public-organizers-link"
                className="ml-auto shrink-0 self-center rounded-lg px-2.5 py-1.5 whitespace-nowrap text-gray-400 underline-offset-4 transition-colors hover:text-gray-600 hover:underline dark:text-gray-500 dark:hover:text-gray-300"
              >
                Organizers <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </nav>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <SiteFooter />
    </div>
  );
}

/**
 * The one page header for a route rendered INSIDE `Shell` — title, the sentence
 * that says what the screen is for, and the actions that operate on it.
 *
 * It exists because the five organizer screens a judge walks had four different
 * header shapes: `/admin/submissions` stacked title over subtitle and put five
 * buttons on a second row, `/admin/agenda` put title, subtitle and five buttons
 * on ONE baseline-aligned row, `/admin/reviews` had no actions at all, and
 * `/admin/contacts` and `/admin/speakers` each invented a third arrangement. All
 * five spelled the title `text-xl font-semibold` — the same size the section
 * headings BELOW them use — so no screen had a first thing for the eye to hit.
 *
 * The rule under it is load-bearing, not decoration: without it the header sat
 * on the page ground with the same 16px gap as everything else and read as the
 * first card rather than the frame around them.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 border-b border-gray-200 pb-5 dark:border-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className={`mb-1 ${eyebrowClass}`}>{eyebrow}</p> : null}
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{title}</h2>
          {description ? (
            <p className="mt-1.5 max-w-prose text-sm leading-6 text-gray-600 dark:text-gray-400">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The one footer, rendered by `Shell` and by the portal chrome — which
 * deliberately does not use `Shell`. Exported rather than duplicated: two
 * copies of a footer drift the first time either measure or either link
 * changes.
 *
 * `contentinfo`, not `banner` — every `getByRole("banner")` assertion in
 * ws12-multi-event and organizer-nav-reach is unaffected by adding this.
 *
 * Text only. No logo, no icon font, no external stylesheet, zero extra
 * requests: the coupling `research/curtaincall-review.md` flags on the rival
 * entry (jQuery + Fomantic-UI off third-party CDNs on every page) is exactly
 * what a footer is the temptation to introduce.
 */
export function SiteFooter({ measure = "max-w-6xl" }: { measure?: string }) {
  return (
    <footer className="border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div
        className={`mx-auto flex ${measure} flex-wrap items-center gap-x-4 gap-y-1 px-4 py-5 text-sm text-gray-600 sm:px-6 dark:text-gray-400`}
      >
        <span className="font-semibold text-gray-900 dark:text-gray-100">callboard</span>
        <span>Run a call for proposals end to end.</span>
        <a className={`${linkClass} sm:ml-auto`} href="https://callboardhq.com">
          callboardhq.com
        </a>
        <a className={linkClass} href="https://github.com/conorbronsdon/callboard-app">
          Source
        </a>
        <span>MIT</span>
      </div>
    </footer>
  );
}

/**
 * Fires the instant ANY other `<form method="post">` submits, before this
 * module's React state has had a chance to re-render. A capture-phase
 * `document` listener runs synchronously as part of the SAME browser event
 * dispatch that starts the sibling submission — unlike a `disabled` attribute
 * driven by `useNavigation()`, there is no render-commit gap for a second,
 * near-simultaneous click to slip through. Cleared once that navigation
 * settles back to idle (see `SignOutButton`). Client-only; safe as a no-op
 * during SSR since `document` never exists there.
 */
const otherMutationInFlight = { current: false };
let guardInstalled = false;
function installMutationRaceGuard() {
  if (guardInstalled || typeof document === "undefined") return;
  guardInstalled = true;
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && form.getAttribute("action") !== "/logout") {
        otherMutationInFlight.current = true;
      }
    },
    true,
  );
}

/**
 * One-click sign-out.
 *
 * It is a POST — signing out is a state change and must not be reachable by a
 * link prefetcher following a GET — but it costs the user a single click. The
 * `/logout` page still exists as the no-JS fallback for a direct visit; nothing
 * in the app routes a person through it.
 *
 * Two-layered guard against racing an in-flight mutation. This button lives
 * in the persistent nav next to every admin/portal action, so a click here
 * has always been able to win React Router's navigation-cancellation race
 * against an unrelated pending submission (e.g. "Open form") and silently
 * drop it before its request ever reached the network — confirmed via
 * request tracing, and confirmed AGAIN as a still-flaky residual gap once
 * `disabled` alone (driven by `useNavigation()`) was measured under two
 * genuinely-simultaneous clicks: React's re-render lands one tick after the
 * DOM event that triggers it, and a fast-enough second click's actionability
 * check can land inside that gap.
 * 1. `disabled`/`aria-disabled` from `useNavigation()` — the visible state,
 *    correct for every human click.
 * 2. `onSubmit` checks the synchronous capture-phase flag above and calls
 *    `preventDefault()` — closes the same-tick gap the render-driven
 *    `disabled` attribute cannot. Both layers read the same underlying fact;
 *    the second one just doesn't wait for a render to know it.
 */
export function SignOutButton({ className }: { className?: string }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  useEffect(() => {
    installMutationRaceGuard();
  }, []);
  useEffect(() => {
    if (navigation.state === "idle") otherMutationInFlight.current = false;
  }, [navigation.state]);

  return (
    <Form
      method="post"
      action="/logout"
      onSubmit={(event) => {
        if (otherMutationInFlight.current) event.preventDefault();
      }}
    >
      <button
        type="submit"
        disabled={busy}
        aria-disabled={busy}
        className={
          (className ??
            "text-gray-600 underline-offset-4 hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-gray-100") +
          (busy ? " cursor-not-allowed opacity-50" : "")
        }
        data-testid="sign-out"
      >
        Sign out
      </button>
    </Form>
  );
}

/**
 * A track's stored colour, used as a chip.
 *
 * The colour is organiser-chosen and arbitrary, so it can never be trusted to
 * carry the text: painting the label in the track hue put all four seeded
 * tracks between 2.42:1 and 4.14:1 on white, every one of them below AA. The
 * hue therefore only ever tints the fill, and the label stays a neutral that is
 * legible against any tint (measured >= 13:1 in both modes). `1f` is ~12%
 * alpha — enough to read as that track's colour, light enough that near-black
 * text sits on it comfortably.
 */
export function TrackChip({
  name,
  color,
}: {
  name: string;
  color: string | null;
}) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap text-gray-900 ring-1 ring-black/5 ring-inset dark:text-gray-100 dark:ring-white/10"
      style={color ? { backgroundColor: `${color}1f` } : undefined}
    >
      {name}
    </span>
  );
}

/** Empty-state panel for a screen with nothing to show yet. */
export function LaneStub({
  lane,
  children,
}: {
  lane: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 dark:border-gray-700 dark:bg-gray-900/40">
      <p className={`mb-2 ${eyebrowClass}`}>{lane}</p>
      <div className="text-sm text-gray-600 dark:text-gray-300">{children}</div>
    </div>
  );
}
