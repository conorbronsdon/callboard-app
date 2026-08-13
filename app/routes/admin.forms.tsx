/**
 * Program › Forms — the submission-form list.
 *
 * The form builder is the heart of the product, and it is easy to lose in a
 * menu, so this page leads with a single obvious `Create form` and never hides
 * it behind one.
 */
import { and, eq, sql } from "drizzle-orm";
import { Form, Link, redirect, useSearchParams } from "react-router";

import { BUTTON_CLASS, Chip, EmptyState, Field, INPUT_CLASS } from "~/components/form-builder";
import { linkClass } from "~/components/shell";
import { getDb } from "~/db/client.server";
import { FORM_TARGETS, forms, sessions } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent, requireCurrentEvent } from "~/lib/event.server";
import {
  effectiveFormStatus,
  emptyFormSchema,
  emptyFormSettings,
  parseFormSchema,
} from "~/lib/form-schema";
import type { Route } from "./+types/admin.forms";

/** CFP wizard targets only `submission` and `session`; contact/group are portal forms. */
const CFP_TARGETS = FORM_TARGETS.filter((t) => t === "submission" || t === "session");

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) {
    return {
      eventSlug: null,
      timezone: "UTC",
      forms: [],
      origin: new URL(request.url).origin,
    };
  }

  const db = getDb();
  const [rows, counts] = await Promise.all([
    db.query.forms.findMany({
      where: and(eq(forms.eventId, event.id), eq(forms.surface, "cfp")),
    }),
    db
      .select({
        formId: sessions.formId,
        status: sessions.status,
        n: sql<number>`count(*)`,
      })
      .from(sessions)
      .where(and(eq(sessions.eventId, event.id), eq(sessions.isAbstract, true)))
      .groupBy(sessions.formId, sessions.status),
  ]);

  const tally = new Map<string, { submissions: number; drafts: number; pending: number }>();
  for (const row of counts) {
    if (!row.formId) continue;
    const entry = tally.get(row.formId) ?? { submissions: 0, drafts: 0, pending: 0 };
    if (row.status === "draft") entry.drafts += Number(row.n);
    else entry.submissions += Number(row.n);
    if (row.status === "pending") entry.pending += Number(row.n);
    tally.set(row.formId, entry);
  }

  return {
    eventSlug: event.slug,
    // Close dates are rendered in the EVENT's timezone, not the Worker's (UTC).
    // "Closes Sep 16" for a deadline an organiser typed as 11:59 PM on the 15th
    // in San Francisco is a wrong date, not a formatting nit.
    timezone: event.timezone,
    origin: new URL(request.url).origin,
    forms: rows
      .filter((row) => row.target === "submission" || row.target === "session")
      .map((row) => {
        const schema = parseFormSchema(row.schema);
        const entry = tally.get(row.id) ?? { submissions: 0, drafts: 0, pending: 0 };
        return {
          id: row.id,
          name: row.name,
          target: row.target,
          status: row.status,
          collectParticipants: schema.participants.collect,
          fieldCount: schema.fields.length,
          ruleCount: schema.rules.length + schema.combinedLimits.length,
          routeCount: schema.routing.rules.length,
          closesAt: row.closesAt ? new Date(row.closesAt).toISOString() : null,
          createdAt: new Date(row.createdAt).toISOString(),
          ...entry,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { error: "Give the form a name." };
    const targetRaw = String(formData.get("target") ?? "submission");
    const target = CFP_TARGETS.includes(targetRaw as never)
      ? (targetRaw as (typeof CFP_TARGETS)[number])
      : "submission";

    const id = crypto.randomUUID();
    await db.insert(forms).values({
      id,
      eventId: event.id,
      surface: "cfp",
      name,
      target,
      status: "draft",
      schema: emptyFormSchema() as never,
      settings: emptyFormSettings() as never,
    });
    return redirect(`/admin/forms/${id}/setup`);
  }

  if (intent === "clone") {
    // `Copy from…` in the `+ Add` split button. Clones the definition, not the
    // submissions — a copy starts as a draft so it cannot accidentally go live.
    const sourceId = String(formData.get("sourceId") ?? "");
    const source = await db.query.forms.findFirst({
      where: and(
        eq(forms.id, sourceId),
        eq(forms.eventId, event.id),
        eq(forms.surface, "cfp"),
      ),
    });
    if (!source) return { error: "That form no longer exists." };

    const id = crypto.randomUUID();
    await db.insert(forms).values({
      id,
      eventId: event.id,
      surface: "cfp",
      name: `${source.name} (copy)`,
      target: source.target,
      status: "draft",
      welcomeTitle: source.welcomeTitle,
      welcomeBody: source.welcomeBody,
      thankYouBody: source.thankYouBody,
      schema: source.schema,
      settings: source.settings,
      minSpeakers: source.minSpeakers,
      maxSpeakers: source.maxSpeakers,
      maxParticipantsTotal: source.maxParticipantsTotal,
      closesAt: source.closesAt,
      submissionLimit: source.submissionLimit,
      allowMultipleDrafts: source.allowMultipleDrafts,
    });
    return redirect(`/admin/forms/${id}/setup`);
  }

  return { error: `Unknown action "${intent}".` };
}

/** "Sep 15" — a created-on date, where the time of day is noise. */
const formatDate = (iso: string | null, timeZone: string) =>
  iso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(iso))
    : null;

/**
 * "Sep 15, 11:59 PM PDT" — a DEADLINE, so the time and the zone are the whole
 * point. Rendered in the event's timezone; the same instant shown as
 * "5:00 AM PDT" or with the day rolled over is how a submitter misses a call.
 */
const formatDeadline = (iso: string | null, timeZone: string) =>
  iso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(iso))
    : null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function AdminForms({ loaderData, actionData }: Route.ComponentProps) {
  const { forms: rows, eventSlug, origin, timezone } = loaderData;
  const [params] = useSearchParams();
  const query = params.get("q")?.toLowerCase() ?? "";
  const statusFilter = params.get("status") ?? "all";
  const now = Date.now();
  const effectiveRows = rows.map((row) => ({
    ...row,
    effectiveStatus: effectiveFormStatus(
      {
        status: row.status,
        closesAt: row.closesAt === null ? null : Date.parse(row.closesAt),
      },
      now,
    ),
  }));

  const visible = effectiveRows.filter((row) => {
    if (query && !row.name.toLowerCase().includes(query)) return false;
    if (statusFilter === "open") return row.effectiveStatus === "open";
    if (statusFilter === "closed") return row.effectiveStatus === "closed";
    return true;
  });

  const tabs = [
    { key: "all", label: "All", n: rows.length },
    {
      key: "open",
      label: "Open",
      n: effectiveRows.filter((row) => row.effectiveStatus === "open").length,
    },
    {
      key: "closed",
      label: "Closed",
      n: effectiveRows.filter((row) => row.effectiveStatus === "closed").length,
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-3">
        <div>
          <h2 className="text-xl font-semibold">Submission forms</h2>
          <p className="text-sm text-gray-500">
            Collect abstract, session and participant information for your event.
          </p>
        </div>
      </header>

      {actionData?.error ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {actionData.error}
        </p>
      ) : null}

      {/*
        * `min-w-0` on both columns is load-bearing, not tidying. A grid item
        * defaults to `min-width: auto`, so it can never be narrower than its
        * min-content — and the truncated share URL below sets `white-space:
        * nowrap`, whose min-content is the whole unbroken UUID. Without this
        * the column inflated to 615px and pushed the 375px page 256px sideways.
        */}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Form method="get" className="flex flex-wrap items-center gap-2">
            <input
              name="q"
              defaultValue={params.get("q") ?? ""}
              placeholder="Search forms…"
              className={`${INPUT_CLASS} max-w-xs`}
              aria-label="Search forms"
            />
            <input type="hidden" name="status" value={statusFilter} />
            <button className={BUTTON_CLASS}>Search</button>
            <span className="ml-auto flex gap-1">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  to={`?status=${tab.key}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    statusFilter === tab.key
                      ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200 ring-inset dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                  }`}
                >
                  {tab.label} {tab.n}
                </Link>
              ))}
            </span>
          </Form>

          {visible.length === 0 ? (
            <EmptyState title={rows.length ? "No forms match that filter." : "No forms yet"}>
              {rows.length ? (
                <Link className={linkClass} to="?status=all">
                  Clear the filter
                </Link>
              ) : (
                <>Create a form to start collecting submissions. It takes about a minute.</>
              )}
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {visible.map((row) => (
                <li
                  key={row.id}
                  className="rounded-xl border border-gray-200 bg-white p-4 shadow-card sm:p-5 dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {/* The bare number in a circle told nobody anything. It is
                        now labelled in the badge itself and to a screen reader,
                        not only in a tooltip nobody hovers. */}
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-300 px-2 py-0.5 text-xs dark:border-gray-700"
                      title={`${plural(row.pending, "submission")} awaiting a decision`}
                      aria-label={`${plural(row.pending, "submission")} awaiting a decision`}
                    >
                      <span className="font-semibold tabular-nums">{row.pending}</span>
                      <span className="text-gray-500">to review</span>
                    </span>
                    <Link
                      to={`/admin/forms/${row.id}/setup`}
                        className="text-sm font-semibold text-gray-900 underline-offset-4 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300"
                    >
                      {row.name}
                    </Link>
                    <span data-testid={`form-status-${row.id}`}>
                      <Chip tone={row.effectiveStatus === "open" ? "accent" : "neutral"}>
                        {row.effectiveStatus}
                      </Chip>
                    </span>
                    <Chip>
                      {row.target === "submission" ? "Abstracts" : "Sessions"}
                      {row.collectParticipants ? " & participants" : ""}
                    </Chip>
                    {row.ruleCount ? <Chip tone="warn">{plural(row.ruleCount, "rule")}</Chip> : null}
                    {row.routeCount ? (
                      <Chip tone="warn">{plural(row.routeCount, "route")}</Chip>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {plural(row.submissions, "submission")} · {plural(row.drafts, "draft")} ·{" "}
                    {plural(row.fieldCount, "field")}
                    {row.closesAt ? ` · Closes ${formatDeadline(row.closesAt, timezone)}` : ""}
                    {` · Created ${formatDate(row.createdAt, timezone)}`}
                  </p>
                  {eventSlug ? (
                    <p className="mt-2">
                      {/*
                        * `block truncate`, not a flex row: a flex child will
                        * not shrink below its content width without `min-w-0`,
                        * so an untruncated UUID pushed the 375px page 256px
                        * sideways. A block element just clips.
                        */}
                      <a
                        className="block truncate rounded-lg bg-gray-100 px-2.5 py-1 font-mono text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                        href={`/submit/${eventSlug}/${row.id}`}
                      >
                        {origin}/submit/{eventSlug}/{row.id}
                      </a>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <h3 className="mb-3 text-sm font-semibold">Create form</h3>
            <Form method="post" className="space-y-3">
              <Field label="Name" hint="Internal — submitters never see this.">
                <input
                  name="name"
                  required
                  className={INPUT_CLASS}
                  placeholder="Call for Proposals 2026"
                />
              </Field>
              <Field label="Collects" hint="Fixed once submissions arrive.">
                <select name="target" className={INPUT_CLASS} defaultValue="submission">
                  <option value="submission">Abstracts — reviewed before acceptance</option>
                  <option value="session">Sessions — a guaranteed slot, no review</option>
                </select>
              </Field>
              <button name="intent" value="create" className={BUTTON_CLASS}>
                Create form
              </button>
            </Form>
          </div>

          {rows.length ? (
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <h3 className="mb-3 text-sm font-semibold">Copy from…</h3>
              <Form method="post" className="space-y-3">
                <Field label="Source form" hint="Copies fields, rules and settings — not submissions.">
                  <select name="sourceId" className={INPUT_CLASS}>
                    {rows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <button name="intent" value="clone" className={BUTTON_CLASS}>
                  Duplicate
                </button>
              </Form>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
