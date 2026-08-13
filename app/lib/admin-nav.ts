export type AdminNavLink = { to: string; label: string; end?: boolean };
export type AdminNavGroup = { key: string; label: string; items: AdminNavLink[] };
export type AdminNavEntry = AdminNavLink | AdminNavGroup;

export function isAdminNavGroup(entry: AdminNavEntry): entry is AdminNavGroup {
  return "items" in entry;
}

/**
 * Builds the organizer nav in event-build frequency order: daily programme
 * work comes first, supporting content follows, and infrequent configuration
 * stays last. `reviewerWorkspaceHref` is threaded in because the selected
 * event's slug comes from loader data rather than a fixed route.
 */
export function buildAdminNav(reviewerWorkspaceHref: string): AdminNavEntry[] {
  return [
    { to: "/admin", label: "Dashboard", end: true },
    {
      key: "programme",
      label: "Programme",
      items: [
        { to: "/admin/agenda", label: "Agenda" },
        { to: "/admin/submissions", label: "Submissions" },
        { to: "/admin/speakers", label: "Speakers" },
        { to: "/admin/tasks", label: "Tasks" },
      ],
    },
    {
      key: "cfp",
      label: "CFP & Forms",
      items: [
        { to: "/admin/forms", label: "Forms" },
        { to: "/admin/portal-forms", label: "Portal forms" },
        { to: "/admin/templates", label: "Templates" },
      ],
    },
    {
      key: "review",
      label: "Review",
      items: [
        { to: "/admin/reviews", label: "Review ops" },
        { to: reviewerWorkspaceHref, label: "Reviewer workspace" },
      ],
    },
    {
      key: "people",
      label: "People",
      items: [
        { to: "/admin/contacts", label: "Contacts" },
        { to: "/admin/pipeline", label: "Pipeline" },
      ],
    },
    {
      key: "content",
      label: "Content",
      items: [
        { to: "/admin/resources", label: "Resources" },
        { to: "/admin/files", label: "Files" },
        { to: "/admin/embeds", label: "Embeds" },
      ],
    },
    { to: "/admin/comms", label: "Comms" },
    {
      key: "settings",
      label: "Settings",
      items: [
        { to: "/admin/settings", label: "Settings" },
        { to: "/admin/integrations", label: "Integrations" },
        { to: "/admin/api-keys", label: "API keys" },
        { to: "/admin/jobs", label: "Jobs" },
        { to: "/admin/view-as", label: "View as" },
      ],
    },
  ];
}

/** Missing and repeated destinations make aggregate nav coverage fail loudly. */
export function coverageGaps(
  entries: AdminNavEntry[],
  expectedLabels: string[],
): { missing: string[]; duplicated: string[] } {
  const labels = entries.flatMap((entry) =>
    isAdminNavGroup(entry) ? entry.items.map((item) => item.label) : [entry.label],
  );
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  return {
    missing: expectedLabels.filter((label) => !counts.has(label)),
    duplicated: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([label]) => label),
  };
}
