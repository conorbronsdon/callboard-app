/**
 * Portal → Resources: the speaker wiki (required feature 8).
 */
import { Link } from "react-router";
import { and, asc, eq } from "drizzle-orm";

import { Card, EmptyState } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { resources } from "~/db/schema";
import { markdownExcerpt } from "~/lib/markdown";
import { portalContext } from "~/lib/portal/portal.server";
import type { Route } from "./+types/portal.resources";

export function meta() {
  return [{ title: "Resources — callboard" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { event } = await portalContext(request);

  const rows = await getDb()
    .select({
      slug: resources.slug,
      title: resources.title,
      body: resources.body,
      hasEmbed: resources.htmlEmbed,
    })
    .from(resources)
    .where(and(eq(resources.eventId, event.id), eq(resources.isPublished, true)))
    .orderBy(asc(resources.order))
    .limit(100);

  return {
    eventName: event.name,
    pages: rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      excerpt: markdownExcerpt(row.body),
      hasEmbed: Boolean(row.hasEmbed),
    })),
  };
}

export default function PortalResources({ loaderData }: Route.ComponentProps) {
  const { eventName, pages } = loaderData;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Resources</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Handbooks, AV notes and logistics for {eventName}.
        </p>
      </header>

      {pages.length === 0 ? (
        <EmptyState title="No resource pages yet">
          The programme team has not published a speaker handbook for this event.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {pages.map((page) => (
            <li key={page.slug}>
              <Card title={page.title} tone="plain">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {page.excerpt || "No summary."}
                </p>
                <p className="mt-3">
                  <Link
                    to={`/portal/resources/${page.slug}`}
                    className="text-sm font-medium text-blue-700 underline dark:text-blue-300"
                  >
                    Read →
                  </Link>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
