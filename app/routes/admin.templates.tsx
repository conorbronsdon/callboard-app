/**
 * Program > Email templates (PLAN.md §4 WS5).
 *
 * Edit the copy for every automated send, with a live preview against seed
 * data and a one-click reset. Router-free markup (plain `<form method="post">`,
 * plain `<a>`) for the same reason the abstracts table is (DECISIONS.md #37):
 * it works pre-hydration, and the render tests can drive the default export
 * under `renderToStaticMarkup` with no router context, which is what makes the
 * zero-state and seeded-state assertions real rather than smoke.
 *
 * The preview is server-rendered on every save. There is no client-side
 * "preview as you type" — a round trip is 30 ms and one code path cannot drift
 * from the other, which is the same trade DECISIONS.md #29 made for the form
 * builder.
 */
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  MERGE_FIELDS,
  isTemplateKey,
  previewContext,
  renderEmail,
  unknownMergeFields,
  type TemplateKey,
} from "~/lib/comms/templates";
import {
  loadTemplates,
  resetTemplate,
  saveTemplate,
  type StoredTemplate,
} from "~/lib/comms/templates.server";
import { currentEvent } from "~/lib/event.server";
import type { Route } from "./+types/admin.templates";

export interface TemplatesData {
  event: { id: string; name: string } | null;
  templates: StoredTemplate[];
  selected: StoredTemplate | null;
  preview: { subject: string; text: string } | null;
  /** Merge fields used in the selected template that we cannot fill. */
  unknown: string[];
  fields: typeof MERGE_FIELDS;
  saved: string | null;
  reset: string | null;
}

export function templatesUrl(key?: string | null, suffix = ""): string {
  return `/admin/templates${key ? `?key=${encodeURIComponent(key)}` : ""}${suffix}`;
}

export async function loader({ request }: Route.LoaderArgs): Promise<TemplatesData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const url = new URL(request.url);

  const empty: TemplatesData = {
    event: null,
    templates: [],
    selected: null,
    preview: null,
    unknown: [],
    fields: MERGE_FIELDS,
    saved: null,
    reset: null,
  };
  if (!event) return empty;

  const templates = await loadTemplates(event.id);
  const requested = url.searchParams.get("key");
  const selected =
    (isTemplateKey(requested)
      ? templates.find((template) => template.key === requested)
      : undefined) ?? templates[0];

  return {
    event: { id: event.id, name: event.name },
    templates,
    selected,
    preview: selected ? renderEmail(selected, previewContext()) : null,
    unknown: selected ? unknownMergeFields(`${selected.subject}\n${selected.body}`) : [],
    fields: MERGE_FIELDS,
    saved: url.searchParams.get("saved"),
    reset: url.searchParams.get("reset"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "No event exists yet. Create one in Settings first." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const key = String(formData.get("key") ?? "");
  if (!isTemplateKey(key)) {
    return { ok: false as const, error: `"${key}" is not a known template.` };
  }

  const db = getDb();

  if (intent === "reset") {
    await resetTemplate(event.id, key as TemplateKey, db);
    return redirect(templatesUrl(key, "&reset=1"));
  }

  if (intent === "save") {
    const subject = String(formData.get("subject") ?? "");
    const body = String(formData.get("body") ?? "");
    if (!subject.trim()) {
      return { ok: false as const, error: "A subject is required — an empty one reads as spam." };
    }
    if (!body.trim()) {
      return { ok: false as const, error: "A body is required." };
    }
    await saveTemplate(event.id, key as TemplateKey, { subject, body }, db);
    return redirect(templatesUrl(key, "&saved=1"));
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

/* ---------------------------------------------------------------- UI */

const CARD = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";
const FIELD =
  "w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");
/*
 * The template strip is a set of TABS, not a row of submit buttons: the active
 * one must not wear the page's primary fill. Same active-pill treatment the
 * admin nav already ships (`shell.tsx`), so the product has one selected-state
 * language rather than a third.
 */
const TAB_BASE =
  "rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors";
const TAB_ACTIVE =
  "bg-blue-50 text-blue-700 ring-1 ring-blue-200 ring-inset dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900";
const TAB_INACTIVE =
  "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800";

export function TemplatesView(data: TemplatesData) {
  if (!data.event) {
    return (
      <div className={CARD} data-testid="templates-empty">
        <h2 className="text-lg font-semibold">Email templates</h2>
        <p className="mt-1 text-sm text-gray-500">
          No event exists yet, so there is nothing to write to. Create one in Settings first.
        </p>
      </div>
    );
  }

  const selected = data.selected!;
  const preview = data.preview!;

  return (
    <div className="space-y-4" data-testid="templates">
      <div>
        <h2 className="text-xl font-semibold">Email templates</h2>
        <p className="text-sm text-gray-500">
          Every automated message callboard sends. Edit the copy, preview it against sample
          data, and reset any of them back to the shipped default.
        </p>
      </div>

      {data.saved ? (
        <p
          className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm dark:border-green-800 dark:bg-green-950"
          data-testid="templates-saved"
        >
          Saved. The preview below is exactly what recipients will get.
        </p>
      ) : null}
      {data.reset ? (
        <p
          className="rounded border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          data-testid="templates-reset"
        >
          Reset to the shipped default.
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-2" data-testid="template-tabs">
        {data.templates.map((template) => (
          <a
            key={template.key}
            href={templatesUrl(template.key)}
            className={`${TAB_BASE} ${template.key === selected.key ? TAB_ACTIVE : TAB_INACTIVE}`}
          >
            {template.name}
            {template.isCustomized ? " ·" : ""}
          </a>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={CARD}>
          <h3 className="text-sm font-semibold tracking-wide text-gray-500 uppercase">
            {selected.name}
          </h3>
          <p className="mt-1 mb-3 text-sm text-gray-500">{selected.trigger}</p>
          <p className="mb-3 text-xs text-gray-500">
            {selected.isCustomized
              ? "Customised for this event."
              : "Currently the shipped default — saving creates an override."}
          </p>

          <form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="key" value={selected.key} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium tracking-wide text-gray-500 uppercase">
                Subject
              </span>
              <input className={FIELD} name="subject" defaultValue={selected.subject} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium tracking-wide text-gray-500 uppercase">
                Body
              </span>
              <textarea className={FIELD} name="body" rows={16} defaultValue={selected.body} />
            </label>
            <div className="flex gap-2">
              <button type="submit" className={BUTTON}>
                Save
              </button>
            </div>
          </form>

          <form method="post" className="mt-2">
            <input type="hidden" name="intent" value="reset" />
            <input type="hidden" name="key" value={selected.key} />
            <button type="submit" className={GHOST} disabled={!selected.isCustomized}>
              Reset to default
            </button>
          </form>
        </section>

        <div className="space-y-4">
          <section className={CARD} data-testid="template-preview">
            <h3 className="mb-2 text-sm font-semibold tracking-wide text-gray-500 uppercase">
              Preview (sample data)
            </h3>
            {data.unknown.length ? (
              <p
                className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950"
                data-testid="template-unknown-fields"
              >
                Unknown merge field{data.unknown.length === 1 ? "" : "s"}:{" "}
                <code className="font-mono">{data.unknown.join(", ")}</code>. These render as
                nothing — check the spelling against the list below.
              </p>
            ) : null}
            <p className="text-sm">
              <span className="text-gray-500">Subject: </span>
              <span data-testid="preview-subject">{preview.subject}</span>
            </p>
            <pre
              className="mt-2 overflow-x-auto rounded bg-gray-50 p-3 text-sm whitespace-pre-wrap dark:bg-gray-900"
              data-testid="preview-body"
            >
              {preview.text}
            </pre>
          </section>

          <section className={CARD}>
            <h3 className="mb-2 text-sm font-semibold tracking-wide text-gray-500 uppercase">
              Merge fields
            </h3>
            <ul className="space-y-1 text-sm">
              {data.fields.map((field) => (
                <li key={field.key}>
                  <code className="font-mono">{`{{${field.key}}}`}</code>
                  <span className="text-gray-500"> — {field.label}</span>
                  {field.aliases.length ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {" "}
                      (also {field.aliases.map((alias) => `{{${alias}}}`).join(", ")})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function AdminTemplates({ loaderData }: Route.ComponentProps) {
  return <TemplatesView {...loaderData} />;
}
