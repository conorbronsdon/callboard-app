/**
 * Program > Comms — the per-speaker send history (PLAN.md §4 WS5).
 *
 * Answers the question an organiser actually asks: "did that speaker get the
 * email?" So the FAILED rows are as prominent as the sent ones — a comm log
 * that only shows successes is a log that cannot tell you why someone did not
 * turn up.
 *
 * Router-free markup, same reasoning as admin.agenda.tsx / admin.templates.tsx.
 */
import { useState } from "react";
import { asc, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { Card, FieldLabel, Notice, buttonClass, inputClass } from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import { getDb } from "~/db/client.server";
import { eventPeople, people, tracks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import {
  BULK_AUDIENCES,
  BULK_CUSTOM_TEMPLATE_KEY,
  isBulkAudience,
  selectRecipients,
  validateCompose,
  type BulkAudience,
  type BulkRecipient,
} from "~/lib/comms/bulk";
import {
  loadComposeRecipients,
  previewBulkComm,
  sendBulkComm,
  type BulkPreview,
  type BulkSendRow,
} from "~/lib/comms/bulk.server";
import { listComms, type CommLogRow } from "~/lib/comms/comm-log.server";
import { DEFAULT_TEMPLATES, MERGE_FIELDS, isTemplateKey } from "~/lib/comms/templates";
import { loadTemplates, type StoredTemplate } from "~/lib/comms/templates.server";
import { appUrl } from "~/lib/env.server";
import { currentEvent } from "~/lib/event.server";
import { getMailer } from "~/lib/mail/mailer.server";
import type { Route } from "./+types/admin.comms";

export interface CommsRow extends CommLogRow {
  personName: string | null;
}

export interface CommsData {
  event: { id: string; name: string; timezone: string } | null;
  rows: CommsRow[];
  people: { id: string; name: string; email: string }[];
  personId: string | null;
  personName: string | null;
  counts: { total: number; sent: number; failed: number };
  /** Optional only so the pre-compose CommsView test fixtures remain source-compatible. */
  compose?: ComposeData;
}

export interface ComposeData {
  recipients: BulkRecipient[];
  filteredRecipientIds: string[];
  audiences: typeof BULK_AUDIENCES;
  audience: BulkAudience;
  trackId: string | null;
  tracks: { id: string; name: string }[];
  templates: StoredTemplate[];
  templateKey: string;
  subject: string;
  body: string;
  fields: typeof MERGE_FIELDS;
  sent: number | null;
  failed: number | null;
  selectionKey: string;
}

export interface ComposeFormState {
  recipientIds: string[];
  audience: BulkAudience;
  trackId: string;
  templateKey: string;
  subject: string;
  body: string;
  previewPersonId: string;
}

export type CommsActionData =
  | { ok: false; error: string; form?: ComposeFormState }
  | {
      ok: true;
      intent: "preview";
      form: ComposeFormState;
      preview: BulkPreview & { personId: string; personName: string; email: string };
    }
  | {
      ok: true;
      intent: "send";
      form: ComposeFormState;
      rows: BulkSendRow[];
    };

export function commsUrl(personId?: string | null): string {
  return `/admin/comms${personId ? `?person=${encodeURIComponent(personId)}` : ""}`;
}

/** Template key -> the name shown in the editor, so the two pages agree. */
function templateLabel(key: string | null): string {
  if (!key) return "—";
  // A free-form bulk send has no template row; showing the raw sentinel key in
  // the history column would leak an implementation detail into the UI.
  if (key === BULK_CUSTOM_TEMPLATE_KEY) return "Bulk email";
  return isTemplateKey(key) ? DEFAULT_TEMPLATES[key].name : key;
}

export async function loader({ request }: Route.LoaderArgs): Promise<CommsData> {
  await requireAdmin(request);
  const event = await currentEvent(request);

  const empty: CommsData = {
    event: null,
    rows: [],
    people: [],
    personId: null,
    personName: null,
    counts: { total: 0, sent: 0, failed: 0 },
  };
  if (!event) return empty;

  const db = getDb();
  const url = new URL(request.url);
  const personId = url.searchParams.get("person");
  const requestedAudience = url.searchParams.get("audience");
  const audience = isBulkAudience(requestedAudience) ? requestedAudience : "all_speakers";
  const trackId = url.searchParams.get("track") || null;
  const requestedTemplate = url.searchParams.get("template");

  const [rows, roster, composeRecipients, templateRows, trackRows] = await Promise.all([
    listComms({ eventId: event.id, personId, limit: 250, db }),
    db
      .select({ id: people.id, name: people.fullName, email: people.email })
      .from(eventPeople)
      .innerJoin(people, eq(people.id, eventPeople.personId))
      .where(eq(eventPeople.eventId, event.id))
      .orderBy(asc(people.email)),
    loadComposeRecipients({ eventId: event.id, db }),
    loadTemplates(event.id, db),
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.order), asc(tracks.name)),
  ]);

  const selectedTemplate = isTemplateKey(requestedTemplate)
    ? templateRows.find((template) => template.key === requestedTemplate) ?? null
    : null;
  const filtered = selectRecipients(composeRecipients, audience, trackId);

  // The roster is already loaded for the filter, so naming the recipients costs
  // no extra query — and an address with no matching person still renders.
  const names = new Map(roster.map((row) => [row.email, row.name]));

  return {
    event: { id: event.id, name: event.name, timezone: event.timezone },
    rows: rows.map((row) => ({ ...row, personName: names.get(row.toEmail) ?? null })),
    people: roster.map((row) => ({
      id: row.id,
      name: row.name ?? row.email,
      email: row.email,
    })),
    personId,
    personName: personId
      ? (roster.find((row) => row.id === personId)?.name ??
        roster.find((row) => row.id === personId)?.email ??
        null)
      : null,
    counts: {
      total: rows.length,
      sent: rows.filter((row) => row.status === "sent").length,
      failed: rows.filter((row) => row.status === "failed" || row.status === "bounced").length,
    },
    compose: {
      recipients: composeRecipients,
      filteredRecipientIds: filtered.map((recipient) => recipient.personId),
      audiences: BULK_AUDIENCES,
      audience,
      trackId,
      tracks: trackRows,
      templates: templateRows,
      templateKey: selectedTemplate?.key ?? "",
      subject: selectedTemplate?.subject ?? "",
      body: selectedTemplate?.body ?? "",
      fields: MERGE_FIELDS,
      sent: url.searchParams.has("sent") ? Number(url.searchParams.get("sent")) : null,
      failed: url.searchParams.has("failed") ? Number(url.searchParams.get("failed")) : null,
      selectionKey: `${audience}:${trackId ?? ""}:${selectedTemplate?.key ?? "custom"}`,
    },
  };
}

function formState(formData: FormData): ComposeFormState {
  const audienceValue = String(formData.get("audience") ?? "all_speakers");
  return {
    recipientIds: formData.getAll("recipientIds").map(String),
    audience: isBulkAudience(audienceValue) ? audienceValue : (audienceValue as BulkAudience),
    trackId: String(formData.get("trackId") ?? ""),
    templateKey: String(formData.get("templateKey") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    previewPersonId: String(formData.get("previewPersonId") ?? ""),
  };
}

export async function action({ request }: Route.ActionArgs): Promise<CommsActionData | Response> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) {
    return { ok: false, error: "No event exists yet. Create one in Settings first." };
  }

  const db = getDb();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const form = formState(formData);
  const [recipients, trackRows, templates] = await Promise.all([
    loadComposeRecipients({ eventId: event.id, db }),
    db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.eventId, event.id)),
    loadTemplates(event.id, db),
  ]);
  const validation = validateCompose({
    subject: form.subject,
    body: form.body,
    recipientIds: form.recipientIds,
    audience: form.audience,
    trackId: form.trackId,
    validTrackIds: trackRows.map((track) => track.id),
  });
  if (!validation.ok) return { ok: false, error: validation.error, form };

  const selectedTemplate = isTemplateKey(form.templateKey)
    ? templates.find((template) => template.key === form.templateKey) ?? null
    : null;
  const origin = appUrl(request);
  const eventContext = {
    name: event.name,
    location: event.location,
    timezone: event.timezone,
  };

  if (intent === "preview") {
    const previewId = form.previewPersonId || form.recipientIds[0];
    const recipient = recipients.find((candidate) => candidate.personId === previewId);
    if (!recipient || !form.recipientIds.includes(previewId)) {
      return { ok: false, error: "Choose one of the selected recipients to preview.", form };
    }
    return {
      ok: true,
      intent: "preview",
      form: { ...form, previewPersonId: previewId },
      preview: {
        ...previewBulkComm({
          recipient,
          event: eventContext,
          subject: form.subject,
          body: form.body,
          templateKey: selectedTemplate?.key ?? BULK_CUSTOM_TEMPLATE_KEY,
          origin,
        }),
        personId: recipient.personId,
        personName: recipient.fullName ?? recipient.email,
        email: recipient.email,
      },
    };
  }

  if (intent === "send") {
    const result = await sendBulkComm({
      eventId: event.id,
      event: eventContext,
      recipients: form.recipientIds,
      subject: form.subject,
      body: form.body,
      templateKey: selectedTemplate?.key ?? BULK_CUSTOM_TEMPLATE_KEY,
      templateId: selectedTemplate?.id ?? null,
      audience: form.audience,
      origin,
      mailer: getMailer(),
      db,
    });
    if (result.error) return { ok: false, error: result.error, form };
    return redirect(`/admin/comms?sent=${result.sent}&failed=${result.failed}`);
  }

  return { ok: false, error: `Unknown intent "${intent}".`, form };
}

/* ---------------------------------------------------------------- UI */

const CARD =
  "rounded-xl border border-gray-200 bg-white p-4 shadow-card dark:border-gray-800 dark:bg-gray-900";
const GHOST = buttonClass("secondary");
const BUTTON = buttonClass("primary");

function StatusPill({ status }: { status: string }) {
  const failed = status === "failed" || status === "bounced";
  return (
    <span
      data-testid={`comm-status-${status}`}
      className={
        failed
          ? "rounded-full bg-rose-100 px-2.5 py-1 text-xs font-medium text-rose-900 ring-1 ring-rose-600/20 ring-inset dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30"
          : status === "sent"
            ? "rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-900 ring-1 ring-green-600/20 ring-inset dark:bg-green-950 dark:text-green-200 dark:ring-green-400/30"
            : "rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-400/30"
      }
    >
      {status}
    </span>
  );
}

function when(epoch: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epoch));
}

function ComposePanel({
  compose,
  actionData,
}: {
  compose: ComposeData;
  actionData?: CommsActionData;
}) {
  const posted = actionData && "form" in actionData ? actionData.form : undefined;
  const initialForm: ComposeFormState = posted ?? {
    recipientIds: compose.filteredRecipientIds,
    audience: compose.audience,
    trackId: compose.trackId ?? "",
    templateKey: compose.templateKey,
    subject: compose.subject,
    body: compose.body,
    previewPersonId: compose.filteredRecipientIds[0] ?? "",
  };
  const [selectedIds, setSelectedIds] = useState(initialForm.recipientIds);
  const [filterAudience, setFilterAudience] = useState<BulkAudience>(initialForm.audience);
  const [filterTrackId, setFilterTrackId] = useState(initialForm.trackId);
  /*
   * The filter runs in the browser, not through a GET round trip. The loader
   * already ships every candidate, so a reload buys nothing — and it would cost
   * the draft: subject/body come back from the template (or blank), so
   * re-filtering after typing a body would silently discard it.
   */
  const visibleRecipients = selectRecipients(compose.recipients, filterAudience, filterTrackId);
  const selected = new Set(selectedIds);
  const selectedVisible = visibleRecipients.filter((recipient) => selected.has(recipient.personId));
  const preview = actionData?.ok && actionData.intent === "preview" ? actionData.preview : null;
  const actionError = actionData && !actionData.ok ? actionData.error : null;

  /** Changing the audience re-seeds the selection with exactly what is now visible. */
  const applyFilter = (audience: BulkAudience, trackId: string) => {
    setFilterAudience(audience);
    setFilterTrackId(trackId);
    setSelectedIds(
      selectRecipients(compose.recipients, audience, trackId).map(
        (recipient) => recipient.personId,
      ),
    );
  };

  const selectVisible = () =>
    setSelectedIds((current) => [
      ...new Set([...current, ...visibleRecipients.map((recipient) => recipient.personId)]),
    ]);
  const clearVisible = () =>
    setSelectedIds((current) =>
      current.filter((id) => !visibleRecipients.some((recipient) => recipient.personId === id)),
    );

  return (
    <div data-testid="comms-compose">
      <Card
        title="Compose email"
        action={<span>{selectedVisible.length} of {visibleRecipients.length} selected</span>}
      >
        <div className="space-y-5">
          {compose.sent !== null && compose.failed !== null ? (
            <Notice tone={compose.failed ? "info" : "success"}>
              Sent {compose.sent} of {compose.sent + compose.failed}.
              {compose.failed ? ` ${compose.failed} failed; see the history below.` : ""}
            </Notice>
          ) : null}
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}

          {/*
            * Only the template picker submits: loading a template REPLACES the
            * subject and body, which is a server read, and is the one action
            * here that is allowed to overwrite what the organizer typed. The
            * audience and track selects carry no `name` — they are client-side
            * filter controls whose values ride along in the hidden inputs so a
            * template load keeps the filter.
            */}
          <form method="get" className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="audience" value={filterAudience} />
            <input type="hidden" name="track" value={filterTrackId} />
            <div className="min-w-0">
              <FieldLabel htmlFor="compose-audience">Recipients</FieldLabel>
              <select
                id="compose-audience"
                className={`${inputClass} min-w-0`}
                value={filterAudience}
                onChange={(event) =>
                  applyFilter(event.currentTarget.value as BulkAudience, filterTrackId)
                }
              >
                {compose.audiences.map((audience) => (
                  <option key={audience.id} value={audience.id}>{audience.label}</option>
                ))}
              </select>
            </div>
            {filterAudience === "track" ? (
              <div className="min-w-0">
                <FieldLabel htmlFor="compose-track">Track</FieldLabel>
                <select
                  id="compose-track"
                  className={`${inputClass} min-w-0`}
                  value={filterTrackId}
                  onChange={(event) => applyFilter("track", event.currentTarget.value)}
                >
                  <option value="">Choose a track</option>
                  {compose.tracks.map((track) => (
                    <option key={track.id} value={track.id}>{track.name}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="min-w-0">
              <FieldLabel htmlFor="compose-template">Template</FieldLabel>
              <select
                id="compose-template"
                name="template"
                defaultValue={initialForm.templateKey}
                className={`${inputClass} min-w-0`}
              >
                <option value="">Write my own</option>
                {compose.templates.map((template) => (
                  <option key={template.key} value={template.key}>{template.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <button type="submit" className={GHOST}>Use template</button>
            </div>
          </form>

          <form method="post" className="space-y-5">
            <input type="hidden" name="audience" value={filterAudience} />
            <input type="hidden" name="trackId" value={filterTrackId} />
            <input type="hidden" name="templateKey" value={initialForm.templateKey} />

            <fieldset>
              <legend className="text-sm font-semibold">Speakers</legend>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p
                  className="text-sm text-gray-600 dark:text-gray-300"
                  aria-live="polite"
                  data-testid="comms-selected-count"
                >
                  {selectedVisible.length} of {visibleRecipients.length} selected
                </p>
                <div className="flex gap-2">
                  <button type="button" className={GHOST} onClick={selectVisible} aria-label="Select all visible recipients">Select all</button>
                  <button type="button" className={GHOST} onClick={clearVisible} aria-label="Select no visible recipients">None</button>
                </div>
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-950">
                {visibleRecipients.length ? (
                  <ul className="space-y-1">
                    {visibleRecipients.map((recipient) => (
                      <li key={recipient.personId}>
                        <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-white dark:hover:bg-gray-900">
                          <input
                            type="checkbox"
                            name="recipientIds"
                            value={recipient.personId}
                            checked={selected.has(recipient.personId)}
                            onChange={(event) => {
                              setSelectedIds((current) =>
                                event.currentTarget.checked
                                  ? [...new Set([...current, recipient.personId])]
                                  : current.filter((id) => id !== recipient.personId),
                              );
                            }}
                            aria-label={`Send to ${recipient.fullName ?? recipient.email}`}
                            className="mt-1 shrink-0"
                          />
                          <span className="min-w-0 text-sm">
                            <span className="font-medium">{recipient.fullName ?? recipient.email}</span>
                            <span className="block break-all text-gray-500 dark:text-gray-400">{recipient.email}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="p-2 text-sm text-gray-500">No speakers match this audience.</p>
                )}
              </div>
            </fieldset>

            <div>
              <FieldLabel htmlFor="compose-subject" required>Subject</FieldLabel>
              <input
                id="compose-subject"
                name="subject"
                required
                defaultValue={initialForm.subject}
                className={inputClass}
              />
            </div>

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <FieldLabel htmlFor="compose-body" required>Body</FieldLabel>
                <textarea
                  id="compose-body"
                  name="body"
                  required
                  rows={14}
                  defaultValue={initialForm.body}
                  className={`${inputClass} min-w-0 font-mono`}
                />
              </div>
              <aside className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
                <h3 className="text-sm font-semibold">Merge fields</h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {compose.fields.map((field) => (
                    <li key={field.key} className="break-words">
                      <code>{`{{${field.key}}}`}</code>
                      <span className="text-gray-500 dark:text-gray-400"> — {field.label}</span>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>

            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <FieldLabel htmlFor="preview-person">Preview recipient</FieldLabel>
                <select
                  id="preview-person"
                  name="previewPersonId"
                  defaultValue={initialForm.previewPersonId || selectedVisible[0]?.personId || ""}
                  className={`${inputClass} min-w-0`}
                >
                  {selectedVisible.map((recipient) => (
                    <option key={recipient.personId} value={recipient.personId}>
                      {recipient.fullName ?? recipient.email} ({recipient.email})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                {/*
                  * No aria-label: this button is unique on the page, and the
                  * recipient it renders is whatever the labelled "Preview
                  * recipient" select holds. Naming the first selected speaker
                  * here (an earlier draft did) is a name that is WRONG the
                  * moment the organizer picks anyone else.
                  */}
                <button type="submit" name="intent" value="preview" className={GHOST}>Preview</button>
                <button type="submit" name="intent" value="send" className={BUTTON}>Send emails</button>
              </div>
            </div>
          </form>

          {preview ? (
            <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950" data-testid="comms-preview">
              <h3 className="font-semibold">Resolved preview</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                Rendered for {preview.personName} &lt;{preview.email}&gt;
              </p>
              {preview.unknownFields.length ? (
                <Notice tone="error">Unknown merge fields: {preview.unknownFields.join(", ")}. They render as empty text.</Notice>
              ) : null}
              {preview.fallbacksUsed.length ? (
                <div className="mt-2"><Notice tone="info">Fallbacks used: {preview.fallbacksUsed.join(", ")}.</Notice></div>
              ) : null}
              <p className="mt-3 break-words text-sm"><span className="text-gray-500 dark:text-gray-400">Subject: </span><span data-testid="comms-preview-subject">{preview.subject}</span></p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-sm whitespace-pre-wrap dark:bg-gray-900" data-testid="comms-preview-body">{preview.text}</pre>
            </section>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

export function CommsView(data: CommsData & { actionData?: CommsActionData }) {
  if (!data.event) {
    return (
      <div className={CARD} data-testid="comms-empty">
        <h2 className="text-lg font-semibold">Comms</h2>
        <p className="mt-1 text-sm text-gray-500">
          No event exists yet. Create one in Settings first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="comms">
      <div>
        <h2 className="text-xl font-semibold">
          Comms{data.personName ? ` — ${data.personName}` : ""}
        </h2>
        <p className="text-sm text-gray-500" data-testid="comms-counts">
          {data.counts.total} message{data.counts.total === 1 ? "" : "s"} · {data.counts.sent}{" "}
          sent · {data.counts.failed} failed
        </p>
      </div>

      {data.compose ? <ComposePanel compose={data.compose} actionData={data.actionData} /> : null}

      <form method="get" className="flex flex-wrap items-end gap-2" data-testid="comms-filter">
        {/*
          * A <select> is as wide as its longest option, and an option here is
          * "Full Name (long.address@example.com)". As a flex item with the
          * default `min-width: auto` that pushed the 375px page 32px sideways
          * (pre-existing — same on origin/main). `min-w-0` lets it shrink,
          * `w-full` makes it fill what is actually available.
          */}
        <label className="block min-w-0">
          <span className={`mb-1 block ${eyebrowClass}`}>
            Speaker
          </span>
          <select
            name="person"
            defaultValue={data.personId ?? ""}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="">Everyone</option>
            {data.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} ({person.email})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BUTTON}>
          Filter
        </button>
        {data.personId ? (
          <a className={GHOST} href={commsUrl(null)}>
            Clear
          </a>
        ) : null}
      </form>

      {data.rows.length === 0 ? (
        <div className={CARD} data-testid="comms-zero">
          <p className="text-sm text-gray-500">
            {data.personId
              ? "Nothing has been sent to this speaker yet."
              : "Nothing has been sent for this event yet. Schedule a published session, or run the task-reminders job from Jobs."}
          </p>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-left text-sm" data-testid="comms-table">
            <thead className={eyebrowClass}>
              <tr>
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Template</th>
                <th className="py-2 pr-4">To</th>
                <th className="py-2 pr-4">Subject</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data.rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="comm-row"
                  className="hover:bg-gray-50 dark:hover:bg-gray-900/50"
                >
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-gray-500">
                    {when(row.createdAt, data.event!.timezone)}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{templateLabel(row.templateKey)}</td>
                  <td className="py-2 pr-4">
                    {row.personName ? (
                      <>
                        {row.personName}{" "}
                        <span className="text-gray-500">&lt;{row.toEmail}&gt;</span>
                      </>
                    ) : (
                      row.toEmail
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {row.subject}
                    {row.meta?.hasIcs ? (
                      <span className="ml-1 text-xs text-gray-500">
                        📅 {String(row.meta?.icsMethod ?? "")} seq {String(row.meta?.icsSequence)}
                      </span>
                    ) : null}
                    {row.error ? (
                      <span className="block text-xs text-red-700 dark:text-red-300">
                        {row.error}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    <StatusPill status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AdminComms({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <CommsView
      key={loaderData.compose?.selectionKey ?? "history-only"}
      {...loaderData}
      actionData={actionData as CommsActionData | undefined}
    />
  );
}
