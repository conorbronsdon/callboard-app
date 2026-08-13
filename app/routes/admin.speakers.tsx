import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { EmbedGrabLink } from "~/components/embed-grab";
import { buttonClass } from "~/components/portal-ui";
import { LaneStub, PageHeader } from "~/components/shell";
import { chunkForBind, chunkedInsert, getDb, type DB } from "~/db/client.server";
import { eventPeople, people } from "~/db/schema";
import { normalizeEmail, requireAdmin } from "~/lib/auth/auth.server";
import { sendBulkComm } from "~/lib/comms/bulk.server";
import { loadTemplate } from "~/lib/comms/templates.server";
import { currentEvent } from "~/lib/event.server";
import { appUrl } from "~/lib/env.server";
import { getMailer } from "~/lib/mail/mailer.server";
import {
  isValidSpeakerEmail,
  parseSpeakerCsv,
  type SpeakerImportPlan,
} from "~/lib/speakers/import-csv";
import {
  isSpeakerStatus,
  speakerStatusBadge,
  SPEAKER_STATUS_BADGES,
} from "~/lib/speakers/roster";
import type { Route } from "./+types/admin.speakers";

type BatchArgument = Parameters<ReturnType<typeof getDb>["batch"]>[0];
type BatchStatement = BatchArgument[number];

const FIELD =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST_BUTTON = buttonClass("secondary");

function escapeLike(value: string): string {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

/**
 * The optional profile columns BOTH roster doors collect (SPK-02).
 *
 * `pronouns` is deliberately absent: neither the Add speaker drawer nor the CSV
 * importer offers it, and a field no door collects cannot be filled from one.
 */
const FILLABLE_PROFILE_FIELDS = ["fullName", "title", "company", "bio"] as const;
type FillableProfileField = (typeof FILLABLE_PROFILE_FIELDS)[number];
type ProfileValues = Partial<Record<FillableProfileField, string | null>>;

/**
 * What to write onto a person who ALREADY EXISTS when an organizer adds them to
 * a roster with the optional fields filled in — SPK-02, caught by the official
 * eval with before/after screenshots.
 *
 * Both add paths only ever INSERTED a people row, and only when the email was
 * new. For an email the system already knew (a submission's author, a contact,
 * a reviewer) the whole insert was skipped, so Title, Company and Biography
 * went nowhere and the profile came back reading "No affiliation on file".
 *
 * The rule is fill-what-is-blank, never overwrite. The old behaviour existed to
 * stop one event's organizer from clobbering a person's global profile, and
 * that protection is real — but a NULL column is not a profile worth
 * protecting. Both goals hold at once as long as "blank" is decided on the
 * stored value rather than on whether the row existed.
 *
 * Whitespace is blank on both sides: a submitted "   " fills nothing, and an
 * existing "   " is not treated as content that blocks a fill.
 */
function blankProfileFill(existing: ProfileValues, submitted: ProfileValues): ProfileValues {
  const patch: ProfileValues = {};
  for (const field of FILLABLE_PROFILE_FIELDS) {
    const value = (submitted[field] ?? "").trim();
    if (!value) continue;
    if ((existing[field] ?? "").trim()) continue;
    patch[field] = value;
  }
  return patch;
}

async function rosterEmails(db: DB, eventId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: people.email })
    .from(eventPeople)
    .innerJoin(people, eq(people.id, eventPeople.personId))
    .where(eq(eventPeople.eventId, eventId));
  return new Set(rows.map((row) => normalizeEmail(row.email)));
}

export function meta() {
  return [{ title: "Speakers — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const requestedStatus = url.searchParams.get("status");
  const status = isSpeakerStatus(requestedStatus) ? requestedStatus : null;
  if (!event) return { speakers: [], q, status };

  const filters = [eq(eventPeople.eventId, event.id)];
  if (q) {
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    filters.push(
      or(
        sql`lower(coalesce(${people.fullName}, '')) like ${pattern} escape '!'`,
        sql`lower(${people.email}) like ${pattern} escape '!'`,
        sql`lower(coalesce(${people.company}, '')) like ${pattern} escape '!'`,
      )!,
    );
  }
  if (status) filters.push(eq(eventPeople.status, status));

  const rows = await getDb()
    .select({
      id: people.id,
      email: people.email,
      fullName: people.fullName,
      title: people.title,
      company: people.company,
      eventRole: eventPeople.eventRole,
      status: eventPeople.status,
    })
    .from(eventPeople)
    .innerJoin(people, eq(people.id, eventPeople.personId))
    .where(and(...filters))
    .orderBy(asc(people.fullName), asc(people.email))
    .limit(200);

  return { speakers: rows, q, status };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "Choose an event first." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const db = getDb();

  if (intent === "add-speaker") {
    const submittedEmail = String(formData.get("email") ?? "");
    const email = normalizeEmail(submittedEmail);
    if (!email) return { ok: false as const, error: "Email is required." };
    if (!isValidSpeakerEmail(email)) {
      return { ok: false as const, error: "Enter a valid email address." };
    }

    const existing = await db.query.people.findFirst({ where: eq(people.email, email) });
    const personId = existing?.id ?? crypto.randomUUID();
    const submitted: ProfileValues = {
      fullName: String(formData.get("fullName") ?? ""),
      title: String(formData.get("title") ?? ""),
      company: String(formData.get("company") ?? ""),
      bio: String(formData.get("bio") ?? ""),
    };
    const statements: BatchStatement[] = [];
    let filled = false;
    if (!existing) {
      statements.push(
        db.insert(people).values({
          id: personId,
          email,
          fullName: submitted.fullName?.trim() || null,
          title: submitted.title?.trim() || null,
          company: submitted.company?.trim() || null,
          bio: submitted.bio?.trim() || null,
          role: "speaker",
        }),
      );
    } else {
      const patch = blankProfileFill(existing, submitted);
      filled = Object.keys(patch).length > 0;
      if (filled) {
        statements.push(db.update(people).set(patch).where(eq(people.id, personId)));
      }
    }
    statements.push(
      db
        .insert(eventPeople)
        .values({ eventId: event.id, personId, eventRole: "speaker" })
        .onConflictDoNothing(),
    );
    await db.batch(statements as unknown as BatchArgument);

    return {
      ok: true as const,
      intent,
      notice: existing
        ? filled
          ? "Existing person attached; blank profile fields were filled in from your entry."
          : "Existing person attached; their global profile was left unchanged."
        : "Speaker added to this event.",
    };
  }

  if (intent === "set-status") {
    const personId = String(formData.get("personId") ?? "");
    const status = String(formData.get("status") ?? "");
    if (!isSpeakerStatus(status)) {
      return { ok: false as const, error: `Unknown speaker status "${status}".` };
    }

    /*
     * The WHERE below already scopes the write to this event, so a POST naming
     * another event's person changes nothing. The membership read exists so the
     * SCREEN does not lie about it: without it, a no-op UPDATE still reported
     * "Speaker status updated." — a success message for a write that never
     * happened is the failure mode worth one extra bounded query.
     */
    const membership = await db.query.eventPeople.findFirst({
      where: and(eq(eventPeople.eventId, event.id), eq(eventPeople.personId, personId)),
    });
    if (!membership) {
      return { ok: false as const, error: "That person is not on this event's roster." };
    }

    await db.batch([
      db
        .update(eventPeople)
        .set({ status })
        .where(and(eq(eventPeople.eventId, event.id), eq(eventPeople.personId, personId))),
    ]);
    return { ok: true as const, intent, notice: "Speaker status updated." };
  }

  if (intent === "send-invite") {
    // Same form field on both the per-row single-send and the roster's bulk
    // send (checkboxes bound via `form="invite-bulk-form"`) — one intent,
    // one-or-many recipients.
    const recipients = [...new Set(formData.getAll("personId").map(String).filter(Boolean))];
    if (recipients.length === 0) {
      return { ok: false as const, error: "Select at least one speaker to invite." };
    }

    const template = await loadTemplate(event.id, "portal_invite", db);
    const result = await sendBulkComm({
      eventId: event.id,
      event: { name: event.name, location: event.location, timezone: event.timezone },
      recipients,
      subject: template.subject,
      body: template.body,
      templateKey: "portal_invite",
      templateId: template.id,
      audience: "all_speakers",
      origin: appUrl(request),
      mailer: getMailer(),
      db,
    });
    if (result.error) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      intent,
      notice:
        result.sent === result.attempted
          ? `Portal invite sent to ${result.sent} speaker${result.sent === 1 ? "" : "s"}. See Comms history for the log.`
          : `Sent ${result.sent} of ${result.attempted}; ${result.failed} failed. See Comms history for details.`,
    };
  }

  if (intent === "import-preview" || intent === "import-commit") {
    let rawCsv: string;
    if (intent === "import-preview") {
      const upload = formData.get("file");
      if (!upload || typeof upload === "string" || typeof upload.text !== "function") {
        return { ok: false as const, error: "Choose a CSV file to preview." };
      }
      rawCsv = await upload.text();
    } else {
      rawCsv = String(formData.get("rawCsv") ?? "");
    }

    const plan = parseSpeakerCsv(rawCsv, await rosterEmails(db, event.id));
    if (plan.fatalError) {
      return { ok: false as const, error: plan.fatalError, preview: plan, rawCsv };
    }
    if (intent === "import-preview") {
      return { ok: true as const, intent, preview: plan, rawCsv };
    }
    if (plan.counts.error > 0) {
      return {
        ok: false as const,
        error: "Import refused because one or more rows have errors. No speakers were added.",
        preview: plan,
        rawCsv,
      };
    }

    const creates = plan.rows.filter((row) => row.classification === "create");
    const existingPeople = new Map<string, { id: string } & ProfileValues>();
    for (const emailChunk of chunkForBind(
      creates.map((row) => row.email),
      1,
    )) {
      if (emailChunk.length === 0) continue;
      const found = await db
        .select({
          id: people.id,
          email: people.email,
          // SPK-02: the current profile, so a fill can tell blank from written.
          fullName: people.fullName,
          title: people.title,
          company: people.company,
          bio: people.bio,
        })
        .from(people)
        .where(inArray(people.email, emailChunk));
      found.forEach((person) => existingPeople.set(person.email, person));
    }

    const plannedPeople = creates.map((row) => {
      const match = existingPeople.get(row.email) ?? null;
      return { row, personId: match?.id ?? crypto.randomUUID(), existing: match };
    });
    const newPeople = plannedPeople
      .filter((entry) => !entry.existing)
      .map(({ row, personId }) => ({
        id: personId,
        email: row.email,
        fullName: row.fullName,
        title: row.title || null,
        company: row.company || null,
        bio: row.bio || null,
        role: "speaker" as const,
      }));
    const links = plannedPeople.map(({ personId }) => ({
      eventId: event.id,
      personId,
      eventRole: "speaker",
    }));
    /*
     * SPK-02 through the bulk door. `parseSpeakerCsv` classifies against THIS
     * EVENT'S roster, so someone who exists globally but has never been on this
     * event arrives here as a "create" — and the insert above skips them. One
     * fill per such person, so the Company and Bio columns an organizer
     * prepared in the spreadsheet stop evaporating on commit.
     */
    const fills = plannedPeople.flatMap(({ row, personId, existing }) => {
      if (!existing) return [];
      const patch = blankProfileFill(existing, row);
      if (Object.keys(patch).length === 0) return [];
      return [db.update(people).set(patch).where(eq(people.id, personId))];
    });
    const statements: BatchStatement[] = [
      ...chunkedInsert(newPeople, (chunk) => db.insert(people).values(chunk)),
      ...fills,
      ...chunkedInsert(links, (chunk) =>
        db.insert(eventPeople).values(chunk).onConflictDoNothing(),
      ),
    ];
    if (statements.length > 0) {
      await db.batch(statements as unknown as BatchArgument);
    }

    return {
      ok: true as const,
      intent,
      preview: plan,
      notice: `Imported ${creates.length} speaker${creates.length === 1 ? "" : "s"}; ${plan.counts.duplicate} duplicate${plan.counts.duplicate === 1 ? "" : "s"} skipped.`,
    };
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

function StatusBadge({ status }: { status: (typeof SPEAKER_STATUS_BADGES)[number]["status"] }) {
  const badge = speakerStatusBadge(status);
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.tone}`}>
      {badge.label}
    </span>
  );
}

/*
 * IN NORMAL DOCUMENT FLOW, not a positioned popover — DECISIONS #41, learned
 * again here. As an `absolute` panel this form rendered but sat permanently
 * "outside of the viewport" at the 375px default, so Playwright retried the
 * submit button for a full minute and never landed a click. An organizer on a
 * phone would have had the same experience. In flow the panel just pushes the
 * page down and nothing can clip it.
 */
const DRAWER_PANEL =
  "mt-2 w-full space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900";

function AddSpeakerDrawer() {
  return (
    <details data-testid="add-speaker-drawer">
      <summary className={`${GHOST_BUTTON} cursor-pointer list-none`}>+ Add speaker</summary>
      <form method="post" className={DRAWER_PANEL}>
        <input type="hidden" name="intent" value="add-speaker" />
        <p className="text-sm font-semibold">Add speaker</p>
        <label className="block text-sm">
          Full name
          <input name="fullName" maxLength={255} className={FIELD} />
        </label>
        <label className="block text-sm">
          Email *
          <input name="email" type="email" required className={FIELD} />
        </label>
        <label className="block text-sm">
          Title
          <input name="title" maxLength={255} className={FIELD} />
        </label>
        <label className="block text-sm">
          Company
          <input name="company" maxLength={255} className={FIELD} />
        </label>
        <label className="block text-sm">
          Biography
          <textarea name="bio" rows={4} className={FIELD} />
        </label>
        <button type="submit" className={BUTTON}>Add speaker</button>
      </form>
    </details>
  );
}

function ImportDrawer() {
  return (
    <details data-testid="import-speaker-drawer">
      <summary className={`${GHOST_BUTTON} cursor-pointer list-none`}>Import CSV</summary>
      <form method="post" encType="multipart/form-data" className={DRAWER_PANEL}>
        <input type="hidden" name="intent" value="import-preview" />
        <p className="text-sm font-semibold">Import speakers</p>
        <p className="text-xs text-gray-500">Preview every row before anything is written.</p>
        <label className="block text-sm">
          CSV file
          <input name="file" type="file" accept=".csv,text/csv" required className={FIELD} />
        </label>
        <button type="submit" className={BUTTON}>Preview import</button>
      </form>
    </details>
  );
}

function ImportPreview({ plan, rawCsv }: { plan: SpeakerImportPlan; rawCsv?: string }) {
  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800" data-testid="speaker-import-preview">
      <div>
        <h3 className="font-semibold">Import preview</h3>
        <p className="text-sm text-gray-500">
          {plan.counts.create} to create · {plan.counts.duplicate} duplicates skipped · {plan.counts.error} errors
        </p>
      </div>
      {plan.rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead><tr className="border-b"><th className="p-2">Row</th><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Result</th><th className="p-2">Reason</th></tr></thead>
            <tbody>
              {plan.rows.map((row) => (
                <tr key={row.rowNumber} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="p-2">{row.rowNumber}</td><td className="p-2">{row.fullName || "—"}</td><td className="p-2">{row.email || "—"}</td><td className="p-2">{row.classification}</td><td className="p-2 text-gray-500">{row.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rawCsv ? (
        <form method="post">
          <input type="hidden" name="intent" value="import-commit" />
          <input type="hidden" name="rawCsv" value={rawCsv} />
          <button type="submit" className={BUTTON}>
            Commit import
          </button>
        </form>
      ) : null}
    </section>
  );
}

export default function AdminSpeakers({ loaderData, actionData }: Route.ComponentProps) {
  const { speakers, q, status } = loaderData;
  const preview = actionData && "preview" in actionData ? actionData.preview : null;
  const rawCsv = actionData && "rawCsv" in actionData ? actionData.rawCsv : undefined;

  const statusHref = (nextStatus: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (nextStatus) params.set("status", nextStatus);
    const query = params.toString();
    return `/admin/speakers${query ? `?${query}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Speakers"
        description="Everyone attached to this event and their workflow status. Change a status inline, or invite a batch to the portal."
        actions={
          <EmbedGrabLink widget="speakers">Embed the speaker directory</EmbedGrabLink>
        }
      />

      {/* Full-width row, not a header flex item: an open drawer's panel needs
          the whole column at 375px, and a flex sibling would squeeze it. */}
      <div className="space-y-2 sm:flex sm:gap-2 sm:space-y-0">
        <div className="sm:flex-1"><ImportDrawer /></div>
        <div className="sm:flex-1"><AddSpeakerDrawer /></div>
      </div>

      {actionData && "error" in actionData ? (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">{actionData.error}</p>
      ) : null}
      {actionData && "notice" in actionData ? (
        <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800" role="status">{actionData.notice}</p>
      ) : null}
      {preview ? <ImportPreview plan={preview} rawCsv={rawCsv} /> : null}

      <form method="get" className="flex flex-wrap items-end gap-2" role="search">
        <label className="min-w-0 flex-1 text-sm">Search name, email, or company
          <input name="q" defaultValue={q} className={FIELD} />
        </label>
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <button type="submit" className={BUTTON}>Search</button>
        {(q || status) ? <a className={GHOST_BUTTON} href="/admin/speakers">Clear</a> : null}
      </form>

      <nav className="flex flex-wrap gap-2" aria-label="Speaker status filters">
        <a className={status === null ? BUTTON : GHOST_BUTTON} href={statusHref(null)}>All</a>
        {SPEAKER_STATUS_BADGES.map((entry) => (
          <a key={entry.status} className={status === entry.status ? BUTTON : GHOST_BUTTON} href={statusHref(entry.status)}>{entry.label}</a>
        ))}
      </nav>

      {speakers.length === 0 ? (
        <LaneStub lane="No speakers found">{q || status ? "No one matches these filters." : "Add a speaker or import a CSV to start this event's roster."}</LaneStub>
      ) : (
        <>
          {/*
           * SPK-06: bulk send lives in its own <form> — nesting a <form> inside
           * each <li>'s status form is invalid HTML — and its inputs are the
           * per-row checkboxes below, associated purely via the `form`
           * attribute (HTML5; the checkbox does not need to be a DOM
           * descendant of the form it submits to).
           */}
          <form method="post" id="invite-bulk-form" className="flex items-center justify-end">
            <input type="hidden" name="intent" value="send-invite" />
            <button type="submit" className={GHOST_BUTTON}>
              Send portal invite to selected
            </button>
          </form>
          <ul className="divide-y divide-gray-200 text-sm dark:divide-gray-800" data-testid="speaker-roster">
            {speakers.map((speaker) => (
              <li key={speaker.id} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    name="personId"
                    value={speaker.id}
                    form="invite-bulk-form"
                    aria-label={`Select ${speaker.fullName ?? speaker.email} for bulk portal invite`}
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <a className="font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300" href={`/admin/speakers/${speaker.id}`}>{speaker.fullName ?? speaker.email}</a>
                    {/* Title and company identify the person at a glance; the
                        roster is how an organizer recognises who is who without
                        opening every record. */}
                    <p className="truncate text-xs text-gray-500">
                      {[speaker.title, speaker.company].filter(Boolean).join(", ") ||
                        "No affiliation on file"}
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      {speaker.email} · {speaker.eventRole}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid={`speaker-status-${speaker.id}`}><StatusBadge status={speaker.status} /></span>
                  <form method="post" className="flex items-center gap-2">
                    <input type="hidden" name="intent" value="set-status" />
                    <input type="hidden" name="personId" value={speaker.id} />
                    {/* `aria-label`, NOT a visually-hidden <label>: an sr-only
                        label puts the speaker's name in the DOM a second time, and
                        `getByText("Ines Duarte")` in the multi-event spec then
                        matches two nodes and fails on strict mode. The accessible
                        name is identical; only the extra text node is gone. */}
                    <select
                      id={`status-${speaker.id}`}
                      name="status"
                      aria-label={`Status for ${speaker.fullName ?? speaker.email}`}
                      defaultValue={speaker.status}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                    >
                      {SPEAKER_STATUS_BADGES.map((entry) => <option key={entry.status} value={entry.status}>{entry.label}</option>)}
                    </select>
                    <button type="submit" className={GHOST_BUTTON}>Save</button>
                  </form>
                  <form method="post">
                    <input type="hidden" name="intent" value="send-invite" />
                    <input type="hidden" name="personId" value={speaker.id} />
                    <button
                      type="submit"
                      className={GHOST_BUTTON}
                      aria-label={`Send portal invite to ${speaker.fullName ?? speaker.email}`}
                    >
                      Send portal invite
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-xs text-gray-500" data-testid="speaker-row-count">{speakers.length} {speakers.length === 1 ? "person" : "people"} shown.</p>
    </div>
  );
}
