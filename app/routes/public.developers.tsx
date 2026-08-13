/**
 * `/developers` — the API docs page.
 *
 * SSR, zero client JS, no docs framework (AGENTS.md #8: public routes stay
 * fast, and a Mintlify-class bundle to render twelve endpoints is the opposite
 * of that). Everything on the page is generated from `API_OPERATIONS`, the same
 * list that generates `/v1/openapi.json`, so the page and the spec cannot
 * disagree.
 *
 * Router-free markup so it renders under `renderToStaticMarkup` in tests.
 */
import { asc } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events } from "~/db/schema";
import { API_OPERATIONS, curlFor, METADATA_FAMILY_PATHS } from "~/lib/api/catalogue";
// Pure module, NOT keys.server — a route component that imports a `.server`
// runtime value renders on the server and then explodes on hydration.
import { API_SCOPES } from "~/lib/api/scopes";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "~/lib/api/envelope";
import type { Route } from "./+types/public.developers";

export function meta() {
  return [
    { title: "callboard API" },
    {
      name: "description",
      content:
        "Callboard's public REST API — Sessionboard-compatible conventions, one envelope, OpenAPI spec.",
    },
  ];
}

export interface DevelopersData {
  origin: string;
  /** A real id from this deployment, so the curl lines are copy-pasteable. */
  eventId: string;
  eventName: string | null;
}

export async function loader({ request }: Route.LoaderArgs): Promise<DevelopersData> {
  const [event] = await getDb().query.events.findMany({
    limit: 1,
    orderBy: [asc(events.createdAt)],
  });
  return {
    origin: new URL(request.url).origin,
    eventId: event?.id ?? "EVENT_ID",
    eventName: event?.name ?? null,
  };
}

const CARD = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";
/**
 * `max-w-full` matters as much as `overflow-x-auto`: a `whitespace-pre` block
 * with a 200-character curl line will widen its parent unless it is capped, and
 * at 375px that turns the whole page into a sideways scroller.
 */
const CODE =
  "max-w-full overflow-x-auto rounded bg-gray-100 p-3 font-mono text-xs whitespace-pre dark:bg-gray-900";

const METHOD_COLOURS: Record<string, string> = {
  GET: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  POST: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
  PUT: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  DELETE: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

export function DevelopersPage({ origin, eventId, eventName }: DevelopersData) {
  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main className="mx-auto max-w-4xl space-y-8 px-4 py-10">
        <header>
          <p className="text-sm text-gray-500">
            <a className="underline" href="/">
              callboard
            </a>{" "}
            / developers
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Public API</h1>
          <p className="mt-2 max-w-2xl text-gray-600 dark:text-gray-300">
            REST/JSON under <code className="font-mono">/v1</code>, event-scoped, with
            Sessionboard-compatible conventions: <code className="font-mono">POST</code>{" "}
            search with a filter body, a <code className="font-mono">/create</code> suffix
            for creates, soft delete plus restore, and the{" "}
            <code className="font-mono">x-access-token</code> header.
          </p>
          <p className="mt-3 flex flex-wrap gap-2 text-sm">
            <a className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-700" href="/v1/openapi.json">
              openapi.json
            </a>
            <a className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-700" href="/admin/api-keys">
              Mint a key
            </a>
          </p>
        </header>

        <section className={CARD}>
          <h2 className="text-lg font-semibold">Authentication</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Mint a key in <strong>Admin → API keys</strong>. The value is shown once and
            stored only as a SHA-256 hash. Keys are scoped to one event, and{" "}
            <strong>scopes do not cascade</strong> — <code className="font-mono">read:sessions</code>{" "}
            grants nothing else, and no read scope ever grants a write.
          </p>
          <pre className={`${CODE} mt-3`}>
            {`export CALLBOARD_KEY='cb_…'\ncurl -sS '${origin}/v1/events' -H "x-access-token: $CALLBOARD_KEY"`}
          </pre>
          <p className="mt-2 text-xs text-gray-500">
            Scopes: {API_SCOPES.join(" · ")}. Missing key → <code className="font-mono">401</code>;
            wrong event or missing scope → <code className="font-mono">403</code>.
          </p>
        </section>

        <section className={CARD}>
          <h2 className="text-lg font-semibold">MCP for agents</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            A separate streamable-HTTP Worker exposes the common programme workflows as
            eight compact tools and reaches Callboard only through this public API. Point
            an MCP client at the <code className="font-mono">/mcp</code> route of that
            Worker and send the same scoped key as{" "}
            <code className="font-mono">x-access-token</code>. The endpoint is deliberately
            not printed here: the MCP Worker is deployed separately from this one and
            shares no configuration with it, so this page cannot know its URL.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Tools: <code className="font-mono">list_events</code>,{" "}
            <code className="font-mono">get_schedule</code>,{" "}
            <code className="font-mono">list_submissions</code>,{" "}
            <code className="font-mono">get_submission</code>,{" "}
            <code className="font-mono">search_speakers</code>,{" "}
            <code className="font-mono">list_tracks</code>,{" "}
            <code className="font-mono">capture_abstract</code>, and{" "}
            <code className="font-mono">get_openapi</code>. Self-hosting and connector
            examples are in <code className="font-mono">docs/MCP.md</code> in the repository.
          </p>
        </section>

        <section className={CARD}>
          <h2 className="text-lg font-semibold">One envelope</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            Every collection returns the same shape. Sessionboard returns{" "}
            <code className="font-mono">{"{results, pagination}"}</code> for POST search and{" "}
            <code className="font-mono">{"{data, pagination}"}</code> with snake_case keys
            for its CRUD-proxy GETs; we do not reproduce that. Unassigned metadata is always{" "}
            <code className="font-mono">null</code>, never <code className="font-mono">{"{}"}</code>.
          </p>
          <pre className={`${CODE} mt-3`}>
            {`{\n  "results": [ … ],\n  "pagination": { "currentPage": 1, "pageSize": ${DEFAULT_PAGE_SIZE}, "totalPages": 4, "totalResults": 97 }\n}`}
          </pre>
          <p className="mt-2 text-xs text-gray-500">
            <code className="font-mono">page</code> and <code className="font-mono">pageSize</code>{" "}
            (default {DEFAULT_PAGE_SIZE}, max {MAX_PAGE_SIZE}) go in the query string on GET
            and in the body on POST search. Errors are{" "}
            <code className="font-mono">{'{ "error": "…", "message": "…" }'}</code>.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">
            Endpoints{eventName ? ` — examples use “${eventName}”` : ""}
          </h2>
          <div className="space-y-4">
            {API_OPERATIONS.map((operation) => (
              <article
                key={operation.operationId}
                id={operation.operationId}
                data-operation={operation.operationId}
                className={CARD}
              >
                <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-xs ${METHOD_COLOURS[operation.method]}`}
                  >
                    {operation.method}
                  </span>
                  {/* `break-all`: `/v1/event/{eventId}/sessions/{sessionId}/restore`
                      has no spaces, so without it the flex row's min-content
                      width is wider than a phone. */}
                  <code className="font-mono text-sm break-all">{operation.path}</code>
                  {operation.scope ? (
                    <span className="ml-auto rounded bg-gray-100 px-2 py-0.5 font-mono text-xs dark:bg-gray-800">
                      {operation.scope}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm font-medium">{operation.summary}</p>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  {operation.description}
                </p>
                <pre className={`${CODE} mt-3`}>{curlFor(operation, origin, eventId)}</pre>
                {operation.responseExample === undefined ? null : (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-gray-500">Example response</summary>
                    <pre className={`${CODE} mt-2`}>
                      {JSON.stringify(operation.responseExample, null, 2)}
                    </pre>
                  </details>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className={CARD}>
          <h2 className="text-lg font-semibold">Notes worth reading before you integrate</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
            <li>
              <strong>Abstracts are sessions.</strong> One resource, discriminated by{" "}
              <code className="font-mono">is_abstract</code>, which is immutable after
              create. An abstract never becomes a session — it gets composed into one, and{" "}
              <code className="font-mono">composition_status</code> tells you which side you
              are looking at.
            </li>
            <li>
              <strong>Metadata families share one handler:</strong>{" "}
              {METADATA_FAMILY_PATHS.map((family) => (
                <code key={family} className="mr-1 font-mono">
                  {family}
                </code>
              ))}
              — same paths, same envelope, same paging.
            </li>
            <li>
              <strong>No read cache.</strong> Sessionboard serves reads up to three minutes
              stale after a write; a read here always reflects the last write, so
              read-after-write tests behave.
            </li>
            <li>
              <strong>Sorting is not restricted to timestamps.</strong> Their API sorts only
              by <code className="font-mono">createdAt</code>/<code className="font-mono">updatedAt</code>;
              this one also accepts <code className="font-mono">startsAt</code> and{" "}
              <code className="font-mono">title</code>.
            </li>
            <li>
              <strong>Optimistic concurrency is opt-in.</strong> Send the{" "}
              <code className="font-mono">updated_at</code> you read on a PUT and a
              concurrent write gives you <code className="font-mono">409</code>; omit it to
              force the write.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

export default function Developers({ loaderData }: Route.ComponentProps) {
  return <DevelopersPage {...loaderData} />;
}
