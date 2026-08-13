/**
 * Speaker portal shell.
 *
 * Deliberately NOT the admin `Shell`: the portal has no left rail, a centred
 * pill tab bar, and — when an admin is viewing as a speaker — a persistent
 * "Back to Admin Mode" bar pinned above everything. The bar is in the layout
 * rather than each page so it cannot be lost by navigating inside the portal.
 */
import { eq } from "drizzle-orm";
import { Form, Link, NavLink, Outlet } from "react-router";

import { Avatar } from "~/components/portal-ui";
import { SignOutButton, SiteFooter } from "~/components/shell";
import { getDb } from "~/db/client.server";
import { uploads } from "~/db/schema";
import { requirePortalActor } from "~/lib/portal/impersonation.server";
import { portalHeadshotHref } from "~/lib/portal-uploads";
import type { Route } from "./+types/portal.layout";

/*
 * 16px stroked glyphs, not emoji. The tab bar used to prefix each label with
 * "⌂ ▤ ◍ ▯ ◈" — characters whose weight, size and even presence depend on
 * the platform's fallback font, so the row rendered differently on every
 * machine a judge might open it on. These are inline paths at a fixed stroke,
 * `aria-hidden` because the label beside them already names the destination.
 */
type TabIconName = "home" | "submissions" | "profile" | "tasks" | "resources";

const ICON_PATHS: Record<TabIconName, string> = {
  home: "M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  submissions: "M4 4h16v16H4zM4 9h16M4 14.5h16",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.5 20a7.5 7.5 0 0 1 15 0",
  tasks: "M4 6.5 6 8.5 9.5 5M4 15.5 6 17.5 9.5 14M13 6.5h7M13 15.5h7",
  resources: "M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2.5h6.5A1.5 1.5 0 0 1 20 8v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z",
};

function TabIcon({ icon }: { icon: TabIconName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={ICON_PATHS[icon]} />
    </svg>
  );
}

const TABS: { to: string; label: string; icon: TabIconName; end?: boolean }[] = [
  { to: "/portal", label: "Home", icon: "home", end: true },
  { to: "/portal/submissions", label: "Submissions", icon: "submissions" },
  { to: "/portal/profile", label: "Profile", icon: "profile" },
  { to: "/portal/tasks", label: "Tasks", icon: "tasks" },
  { to: "/portal/resources", label: "Resources", icon: "resources" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requirePortalActor(request);

  /*
   * The nav-bar avatar's href needs the CURRENT upload's id, not just the
   * key: `portalHeadshotHref` versions the URL with it so a replaced photo
   * is a different `src` string on this shell, which persists across every
   * portal page. Without a version, `headshot_key` changing underneath an
   * unchanged href was exactly the bug (see `portal.profile.headshot-
   * refresh.test.tsx`) — this is the ONE key lookup a nav bar rendered on
   * every portal page can afford, on `uploads_key_idx`, which is unique.
   */
  const headshotUpload = actor.person.headshotKey
    ? await getDb().query.uploads.findFirst({
        where: eq(uploads.key, actor.person.headshotKey),
        columns: { id: true },
      })
    : null;

  return {
    person: {
      email: actor.person.email,
      fullName: actor.person.fullName,
      headshotHref: headshotUpload
        ? portalHeadshotHref(actor.person.id, headshotUpload.id)
        : null,
    },
    impersonatedBy: actor.impersonatedBy
      ? { email: actor.impersonatedBy.email, fullName: actor.impersonatedBy.fullName }
      : null,
  };
}

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const { person, impersonatedBy } = loaderData;
  const displayName = person.fullName ?? person.email;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {impersonatedBy ? (
        <div className="sticky top-0 z-20 bg-amber-400 text-amber-950">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
            <p className="font-medium">
              <span aria-hidden="true">👁 </span>
              Viewing as <strong>{displayName}</strong>
              <span className="hidden sm:inline">
                {" "}
                — signed in as {impersonatedBy.fullName ?? impersonatedBy.email}
              </span>
            </p>
            <Form method="post" action="/portal/impersonate/stop">
              <button
                type="submit"
                className="rounded-lg bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-900"
              >
                Back to Admin Mode
              </button>
            </Form>
          </div>
        </div>
      ) : null}

      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/portal" className="text-base font-semibold tracking-tight">
            callboard
            <span className="ml-2 text-sm font-normal text-gray-600 dark:text-gray-400">
              Speaker portal
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Avatar
              name={person.fullName}
              email={person.email}
              size="sm"
              src={person.headshotHref}
            />
            <SignOutButton className="text-sm text-gray-600 underline underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100" />
          </div>
        </div>

        {/* Pill tabs, not underlined tabs — and horizontally scrollable at 375px. */}
        <nav
          aria-label="Portal sections"
          className="mx-auto flex max-w-4xl gap-2 overflow-x-auto px-4 pb-3"
        >
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                [
                  "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
                    : "border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800",
                ].join(" ")
              }
            >
              <TabIcon icon={tab.icon} />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      {/* Narrower measure: speaker surfaces are deliberately max-w-4xl. */}
      <SiteFooter measure="max-w-4xl" />
    </div>
  );
}
