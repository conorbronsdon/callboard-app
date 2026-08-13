/**
 * One speaker (`/admin/speakers/:id`) — the other end of the drill-in.
 *
 * Deliberately minimal: a profile and everything they have submitted, so that
 * clicking a name on an abstract answers "who is this and what else did they
 * send us?" without leaving the review flow. Per-speaker task completion and
 * comms history are WS6's onboarding dashboard, not this page.
 *
 * FIVE concurrent statements, including uploads and custom-field form tasks,
 * then no further queries.
 *
 * ⚠️ `Promise.all`, not `db.batch`: the submissions query joins `tracks.name`
 * and `formats.name`, and `db.batch` maps D1's object rows with `Object.values`,
 * where two columns called `name` collapse into one and shift the rest. See the
 * same note in admin.submission.tsx.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { data } from "react-router";

import { StatusPill } from "~/components/admin-status";
import { BioEditor } from "~/components/BioEditor";
import { buttonClass } from "~/components/portal-ui";
import { LaneStub, linkClass } from "~/components/shell";
import { Avatar } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import {
  eventPeople,
  forms,
  formats,
  people,
  sessionParticipants,
  sessions,
  tasks,
  tracks,
  uploads,
  type SessionStatus,
  type SpeakerStatus,
} from "~/db/schema";
import { buildLibrary, type LibraryChain, type LibraryRow } from "~/lib/files-library";
import { FileVersions } from "~/components/file-history";
import { requireAdmin } from "~/lib/auth/auth.server";
import { sendBulkComm } from "~/lib/comms/bulk.server";
import { loadTemplate } from "~/lib/comms/templates.server";
import { appUrl } from "~/lib/env.server";
import { currentEvent } from "~/lib/event.server";
import { getMailer } from "~/lib/mail/mailer.server";
import { storeUpload } from "~/lib/portal/uploads.server";
import { readPortalSchema } from "~/lib/portal-form";
import { ACCEPT_ATTRIBUTE, formatBytes } from "~/lib/portal-uploads";
import { RATE_LIMIT_POLICIES, enforceRateLimit } from "~/lib/rate-limit.server";
import { socialHref } from "~/lib/social-href";
import { speakerStatusBadge } from "~/lib/speakers/roster";
import { isOnEventRoster, NOT_ON_ROSTER } from "~/lib/speakers/roster.server";
import { detailUrl } from "./admin.submission";
import type { Route } from "./+types/admin.speaker";

export interface SpeakerSubmission {
  id: string;
  friendlyId: string | null;
  title: string;
  status: SessionStatus;
  isAbstract: boolean;
  role: string;
  isPrimary: boolean;
  trackName: string | null;
  formatName: string | null;
}

export interface SpeakerCustomFieldTask {
  taskId: string;
  taskTitle: string;
  formName: string;
  status: string;
  answers: { key: string; label: string; value: string | null }[];
}

const BIO_MAX = 5000;

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "Choose an event first." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  /*
   * CNT-10 photo half — the organizer replaces the headshot from the admin
   * area. This door and `mayAttachTo` enforce the same event-roster boundary,
   * so neither path grants broader authority than the other.
   *
   * It deliberately does NOT touch `photo_publishable`. An organizer uploading
   * a better crop is a correction, not the speaker's consent to be published,
   * and the toggle below is where that decision is made explicitly. If the
   * speaker had already consented, replacing the file leaves that consent in
   * place — they agreed to have a headshot shown, and this is their headshot.
   */
  if (intent === "replace-headshot") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false as const, error: "Choose an image first." };
    }

    /*
     * The fifth door into `storeUpload`, and the only one behind `requireAdmin`.
     * Charged to the organizer's own upload bucket rather than the speaker's:
     * an organizer working through a roster must not spend the allowance of the
     * person whose record they are on. Enforced inside this branch, not at the
     * top of the action, because the other intents here are bio and invite
     * writes that have no business consuming an upload allowance.
     */
    await enforceRateLimit({
      scope: "upload",
      identifier: admin.id,
      policy: RATE_LIMIT_POLICIES.apiUpload,
      message: "Too many files were uploaded. Please wait before trying again.",
    });

    const db = getDb();
    if (!(await isOnEventRoster(event.id, params.id, db))) {
      return { ok: false as const, error: NOT_ON_ROSTER };
    }

    const result = await storeUpload({
      file,
      eventId: event.id,
      ownerType: "person",
      ownerId: params.id,
      purpose: "headshot",
      uploadedById: admin.id,
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, notice: "Headshot replaced." };
  }

  /*
   * The out-of-band consent path. A headshot uploaded before the portal carried
   * its public-use notice stays private by default, forever, because nobody can
   * retroactively read a speaker's mind about it. When an organizer HAS that
   * permission — a signed speaker agreement, an email, a conversation — this is
   * where they record it, on the record it applies to, one speaker at a time.
   *
   * There is no bulk version of this control on purpose. "Publish all speaker
   * photos" is exactly the action nobody should be able to take by accident.
   */
  if (intent === "set-photo-publishable") {
    const publish = String(formData.get("value") ?? "") === "1";
    const db = getDb();
    if (!(await isOnEventRoster(event.id, params.id, db))) {
      return { ok: false as const, error: NOT_ON_ROSTER };
    }
    /*
     * Consent under DECISIONS #66 is global and per person, not per file or per
     * event; a replacement does not re-ask for it. But it cannot be raised before
     * any headshot exists. The public photo route joins on
     * `uploads.key = people.headshot_key`, so `publishable` with a null key serves
     * nothing today, while a standing true PRE-ARMS the next upload to go public
     * with no fresh consent act. The UI hides this control without a photo; this
     * check guards the direct POST.
     */
    if (publish) {
      const person = await db.query.people.findFirst({ where: eq(people.id, params.id) });
      if (!person?.headshotKey) {
        return { ok: false as const, error: "Upload a headshot before publishing it." };
      }
    }
    await db
      .update(people)
      .set({ photoPublishable: publish })
      .where(eq(people.id, params.id));
    return {
      ok: true as const,
      notice: publish
        ? "This photo now appears on the public speaker pages."
        : "This photo is hidden from the public speaker pages.",
    };
  }

  if (intent === "send-invite") {
    const db = getDb();
    if (!(await isOnEventRoster(event.id, params.id, db))) {
      return { ok: false as const, error: NOT_ON_ROSTER };
    }
    const template = await loadTemplate(event.id, "portal_invite", db);
    const result = await sendBulkComm({
      eventId: event.id,
      event: { name: event.name, location: event.location, timezone: event.timezone },
      recipients: [params.id],
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
      notice:
        result.sent > 0
          ? "Portal invite sent. See Comms history below for the log."
          : `Portal invite failed to send${result.rows[0]?.error ? `: ${result.rows[0].error}` : "."}`,
    };
  }

  if (intent !== "edit-speaker") {
    return { ok: false as const, error: `Unknown intent "${intent}".` };
  }

  const bio = String(formData.get("bio") ?? "");
  if (bio.length > BIO_MAX) {
    return {
      ok: false as const,
      error: `Biography is ${bio.length} characters; the limit is ${BIO_MAX}.`,
    };
  }

  const db = getDb();
  if (!(await isOnEventRoster(event.id, params.id, db))) {
    return { ok: false as const, error: NOT_ON_ROSTER };
  }

  await db.batch([
    db
      .update(people)
      .set({
        fullName: String(formData.get("fullName") ?? "").trim() || null,
        title: String(formData.get("title") ?? "").trim() || null,
        company: String(formData.get("company") ?? "").trim() || null,
        pronouns: String(formData.get("pronouns") ?? "").trim() || null,
        bio: bio.trim() || null,
      })
      .where(eq(people.id, params.id)),
  ]);

  return { ok: true as const, notice: "Speaker details saved." };
}

export function meta() {
  return [{ title: "Speaker — callboard admin" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);

  const empty = {
    speaker: null as null | {
      id: string;
      name: string;
      email: string;
      company: string | null;
      title: string | null;
      pronouns: string | null;
      bio: string | null;
      links: [string, string][];
      eventRole: string | null;
      status: SpeakerStatus | null;
      photoPublishable: boolean;
    },
    headshot: null as null | { uploadId: string; filename: string; size: string },
    submissions: [] as SpeakerSubmission[],
    files: [] as LibraryChain[],
    customFields: [] as SpeakerCustomFieldTask[],
  };
  if (!event) return empty;

  const db = getDb();
  const [personResult, submissionResult, uploadResult, headshotResult, customFieldResult] = await Promise.all([
    db
      .select({
        person: people,
        eventRole: eventPeople.eventRole,
        status: eventPeople.status,
      })
      .from(people)
      .leftJoin(
        eventPeople,
        and(eq(eventPeople.personId, people.id), eq(eventPeople.eventId, event.id)),
      )
      .where(eq(people.id, params.id)),
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        status: sessions.status,
        isAbstract: sessions.isAbstract,
        role: sessionParticipants.role,
        isPrimary: sessionParticipants.isPrimary,
        trackName: tracks.name,
        formatName: formats.name,
      })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .leftJoin(formats, eq(formats.id, sessions.formatId))
      .where(
        and(
          eq(sessionParticipants.personId, params.id),
          eq(sessions.eventId, event.id),
          isNull(sessions.deletedAt),
        ),
      )
      .orderBy(desc(sessions.createdAt)),
    /*
     * SPK-10: the organizer's own view of what this speaker has sent us.
     * Headshots are deliberately NOT filtered out — "is there a photo yet?" is
     * one of the questions this page exists to answer.
     */
    db
      .select({
        upload: uploads,
        uploaderName: people.fullName,
        uploaderEmail: people.email,
      })
      .from(uploads)
      .leftJoin(people, eq(people.id, uploads.uploadedById))
      .where(
        and(
          eq(uploads.eventId, event.id),
          eq(uploads.ownerType, "person"),
          eq(uploads.ownerId, params.id),
        ),
      )
      .orderBy(desc(uploads.createdAt))
      .limit(100),
    /*
     * SPK-08 organizer half. Joined through `people.headshot_key` rather than
     * by taking the newest headshot-purpose row: that column is the single
     * source for WHICH photo is current (`storeUpload` repoints it and deletes
     * the old object), so a "newest row" query could disagree with it after a
     * failed write and show a photo the product no longer considers current.
     */
    db
      .select({
        uploadId: uploads.id,
        filename: uploads.filename,
        sizeBytes: uploads.sizeBytes,
      })
      .from(uploads)
      .innerJoin(people, eq(people.headshotKey, uploads.key))
      .where(eq(people.id, params.id))
      .limit(1),
    db
      .select({
        taskId: tasks.id,
        taskTitle: tasks.title,
        status: tasks.status,
        response: tasks.response,
        formName: forms.name,
        schema: forms.schema,
      })
      .from(tasks)
      .innerJoin(forms, eq(tasks.formId, forms.id))
      .where(and(eq(tasks.personId, params.id), eq(tasks.eventId, event.id)))
      .orderBy(asc(tasks.createdAt))
      .limit(100),
  ]);

  const found = personResult[0];
  /*
   * A person absent from this event is a MISSING RESOURCE, not an empty state,
   * so it answers 404 while keeping the friendly body this route renders.
   * `data()` rather than `throw new Response(404)`, which would surrender the
   * screen to the root ErrorBoundary. The `!event` branch above deliberately
   * stays 200: nothing is missing there, the instance just has no event yet.
   *
   * The sibling of PR #145 finding 5, which fixed the identical shape on
   * /admin/submissions/:id and named this route as carrying it too.
   */
  if (!found) return data(empty, { status: 404 });
  const headshotRow = headshotResult[0];
  const uploadNames = new Map(uploadResult.map((row) => [row.upload.id, row.upload.filename]));

  return {
    speaker: {
      id: found.person.id,
      name: found.person.fullName ?? found.person.email,
      email: found.person.email,
      company: found.person.company,
      title: found.person.title,
      pronouns: found.person.pronouns,
      bio: found.person.bio,
      links: Object.entries((found.person.links ?? {}) as Record<string, string>).filter(
        ([, href]) => typeof href === "string" && href.trim().length > 0,
      ),
      eventRole: found.eventRole,
      status: found.status,
      photoPublishable: found.person.photoPublishable,
    },
    headshot: headshotRow
      ? {
          uploadId: headshotRow.uploadId,
          filename: headshotRow.filename,
          size: formatBytes(headshotRow.sizeBytes),
        }
      : null,
    submissions: submissionResult,
    customFields: customFieldResult.map((row) => {
      const response = (row.response ?? {}) as Record<string, unknown>;
      return {
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        formName: row.formName,
        status: row.status,
        answers: readPortalSchema(row.schema).questions.map((question) => {
          const raw = response[question.key];
          let value: string | null;
          if (
            raw === null ||
            raw === undefined ||
            raw === "" ||
            (Array.isArray(raw) && raw.length === 0)
          ) {
            value = null;
          } else if (question.type === "file") {
            value = typeof raw === "string" ? uploadNames.get(raw) ?? "File uploaded" : null;
          } else if (Array.isArray(raw)) {
            value = raw.map(String).join(", ");
          } else if (typeof raw === "boolean") {
            value = raw ? "Yes" : "No";
          } else {
            value = String(raw);
          }
          return { key: question.key, label: question.label, value };
        }),
      };
    }),
    files: buildLibrary(
      uploadResult.map(
        (row): LibraryRow => ({
          id: row.upload.id,
          versionOf: row.upload.versionOf,
          version: row.upload.version,
          filename: row.upload.filename,
          contentType: row.upload.contentType,
          purpose: row.upload.purpose,
          sizeBytes: row.upload.sizeBytes,
          createdAt: row.upload.createdAt.getTime(),
          ownerType: row.upload.ownerType,
          ownerId: row.upload.ownerId,
          uploaderName: row.uploaderName?.trim() || row.uploaderEmail || null,
          sessionTitle: null,
          ownerPersonName: found.person.fullName ?? found.person.email,
        }),
      ),
    ),
  };
}

/**
 * Strip React Router's `data()` wrapper back off a loader return type.
 *
 * Returning `data(empty, { status: 404 })` from ONE branch widens the whole
 * loader to `Payload | DataWithResponseInit<Payload>`, a union whose arms share
 * no properties — so `.speaker` stops existing for this component's props and
 * for the four test files that call this loader directly. `T` is naked, so the
 * conditional DISTRIBUTES over the union and maps both arms back to a payload;
 * attaching a status stays a runtime concern instead of leaking into consumers.
 *
 * Matched structurally because react-router only exports the class as
 * `UNSAFE_DataWithResponseInit` and types its `type` field as `string`, leaving
 * no discriminant. Deliberately a local twin of the helper admin.submission.tsx
 * introduced in #145: two routes is not yet a shared module, and a third one
 * needing it is the signal to extract rather than copy again.
 */
type UnwrapData<T> = T extends { type: string; data: infer P; init: ResponseInit | null }
  ? P
  : T;

/** The loader's payload, with any `data()` wrapper removed. */
export type SpeakerLoaderData = UnwrapData<Awaited<ReturnType<typeof loader>>>;

/**
 * Unwrap a DIRECT `loader()` call — the shape this suite calls loaders in.
 * React Router strips the wrapper before a component sees it, so only unit
 * tests invoking the loader as a plain function need this.
 */
export function speakerLoaderPayload(
  result: Awaited<ReturnType<typeof loader>>,
): SpeakerLoaderData {
  return (
    result && typeof result === "object" && "data" in result && "init" in result
      ? (result as { data: SpeakerLoaderData }).data
      : result
  ) as SpeakerLoaderData;
}

const CARD = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";

export function SpeakerView({
  speaker,
  headshot,
  submissions,
  customFields,
  files,
  actionData,
}: SpeakerLoaderData & {
  actionData?: { ok: false; error: string } | { ok: true; notice: string };
}) {
  if (!speaker) {
    return (
      <LaneStub lane="Not found">
        No such person in this event.{" "}
        <a className={linkClass} href="/admin/speakers">
          Back to speakers
        </a>
        .
      </LaneStub>
    );
  }

  const abstracts = submissions.filter((row) => row.isAbstract);
  const program = submissions.filter((row) => !row.isAbstract);
  const workflowBadge = speaker.status ? speakerStatusBadge(speaker.status) : null;

  return (
    <div className="space-y-4">
      <div>
        <a className="text-sm text-gray-500 underline" href="/admin/speakers">
          ← Speakers
        </a>
        <h2 className="mt-1 text-xl font-semibold">{speaker.name}</h2>
        <p className="text-sm text-gray-500">
          {[speaker.title, speaker.company].filter(Boolean).join(", ") || "No affiliation on file"}
          {speaker.pronouns ? ` · ${speaker.pronouns}` : ""}
          {speaker.eventRole ? ` · ${speaker.eventRole}` : ""}
        </p>
        {workflowBadge ? (
          <span
            className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${workflowBadge.tone}`}
            data-testid="speaker-detail-status"
          >
            {workflowBadge.label}
          </span>
        ) : null}
        {/* WS5: the send history for THIS person, filtered on arrival. */}
        <a
          className="text-sm underline"
          href={`/admin/comms?person=${encodeURIComponent(speaker.id)}`}
          data-testid="speaker-comms-link"
        >
          Comms history →
        </a>
        {/* SPK-06: explicit, one-off portal invite for this speaker. */}
        <form method="post" className="mt-2">
          <input type="hidden" name="intent" value="send-invite" />
          <button type="submit" className={buttonClass("secondary", "sm")} data-testid="speaker-send-invite">
            Send portal invite
          </button>
        </form>
      </div>

      {actionData && "error" in actionData ? (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">
          {actionData.error}
        </p>
      ) : null}
      {actionData && "notice" in actionData ? (
        <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800" role="status">
          {actionData.notice}
        </p>
      ) : null}

      <section className={CARD} data-testid="speaker-profile">
        <dl className="space-y-3">
          <div>
            <dt className="text-xs font-medium tracking-wide text-gray-500 uppercase">Email</dt>
            <dd className="mt-0.5 text-sm">
              <a className={linkClass} href={`mailto:${speaker.email}`}>
                {speaker.email}
              </a>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-gray-500 uppercase">Biography</dt>
            <dd className="mt-0.5 text-sm leading-relaxed">
              {speaker.bio ? (
                speaker.bio
              ) : (
                <span className="text-gray-500 italic">
                  No bio yet — the speaker has not filled one in.
                </span>
              )}
            </dd>
          </div>
          {speaker.links.length ? (
            <div>
              <dt className="text-xs font-medium tracking-wide text-gray-500 uppercase">Links</dt>
              <dd className="mt-0.5 flex flex-wrap gap-3 text-sm">
                {speaker.links.map(([label, href]) => {
                  const resolvedHref = socialHref(href);
                  return resolvedHref ? (
                    <a key={label} className={linkClass} href={resolvedHref} rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    <span key={label} className="text-gray-500 dark:text-gray-400">
                      {label}
                    </span>
                  );
                })}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className={CARD} data-testid="speaker-custom-fields">
        <h3 className="mb-2 font-semibold">
          Custom fields
        </h3>
        {customFields.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No custom fields for this speaker. Answers appear here when they complete an assigned portal form.
          </p>
        ) : (
          <div className="space-y-4">
            {customFields.map((task) => (
              <div key={task.taskId}>
                <p className="text-sm font-medium">{task.formName}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{task.taskTitle} · {task.status}</p>
                <dl className="mt-2 space-y-2" data-testid="speaker-custom-field-answers">
                  {task.answers.map((answer) => (
                    <div key={answer.key}>
                      <dt className="text-xs font-medium text-gray-500">{answer.label}</dt>
                      <dd className="mt-0.5 text-sm">
                        {answer.value === null ? (
                          <span className="text-gray-500 italic">Not answered yet</span>
                        ) : answer.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={CARD} data-testid="speaker-headshot">
        <h3 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase">
          Headshot
        </h3>
        <div className="flex flex-wrap items-start gap-4">
          {/*
            * The ADMIN preview reads `/portal/headshot/:personId`, the
            * auth-gated route, NOT the public one. An organizer must be able to
            * see the photo on file in order to decide whether to publish it —
            * so the preview cannot be gated on the very flag the control below
            * sets, or the decision would have to be made blind.
            */}
          <Avatar
            name={speaker.name}
            email={speaker.email}
            size="lg"
            src={headshot ? `/portal/headshot/${speaker.id}` : null}
          />
          <div className="min-w-0 flex-1 space-y-3">
            {headshot ? (
              <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="speaker-headshot-file">
                On file: {headshot.filename} ({headshot.size})
              </p>
            ) : (
              <p
                className="text-sm text-gray-500 italic dark:text-gray-400"
                data-testid="speaker-headshot-empty"
              >
                No headshot yet — the speaker has not uploaded one.
              </p>
            )}

            {/*
              * The publish control exists only when there is a photo to publish.
              * `photo_publishable` is meaningless without a `headshot_key` (the
              * public route joins the two), and a toggle on an empty record would
              * let an organizer PRE-ARM consent so the next upload goes public
              * with no fresh act — the same laundering the merge and delete paths
              * now close. Gate the surface on the artifact; the action refuses the
              * direct POST for the same reason.
              */}
            {headshot ? (
              <div
                className={`rounded-lg border p-3 ${
                  speaker.photoPublishable
                    ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40"
                    : "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
                }`}
              >
                <p className="text-sm font-medium" data-testid="speaker-photo-visibility">
                  {speaker.photoPublishable
                    ? "Shown on the public speaker pages."
                    : "Private — not shown on any public page."}
                </p>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  Only turn this on if the speaker has agreed their photo may appear
                  publicly. Photos uploaded through the portal since the public-use
                  notice was added are already marked as agreed.
                </p>
                <form method="post" className="mt-2">
                  <input type="hidden" name="intent" value="set-photo-publishable" />
                  <input
                    type="hidden"
                    name="value"
                    value={speaker.photoPublishable ? "0" : "1"}
                  />
                  <button
                    type="submit"
                    className={buttonClass("secondary", "sm")}
                    data-testid="speaker-photo-toggle"
                  >
                    {speaker.photoPublishable ? "Hide photo from public pages" : "Show photo publicly"}
                  </button>
                </form>
              </div>
            ) : null}

            <form method="post" encType="multipart/form-data" className="space-y-2">
              <input type="hidden" name="intent" value="replace-headshot" />
              <label className="block text-sm font-medium" htmlFor="admin-headshot">
                {headshot ? "Replace headshot" : "Upload a headshot"}
              </label>
              <input
                id="admin-headshot"
                type="file"
                name="file"
                accept={ACCEPT_ATTRIBUTE.headshot}
                required
                className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
              />
              <button
                type="submit"
                className={buttonClass("secondary", "sm")}
                data-testid="speaker-headshot-upload"
              >
                Save headshot
              </button>
            </form>
          </div>
        </div>
      </section>

      <details className={CARD} data-testid="speaker-edit-details">
        <summary className="cursor-pointer font-semibold">Edit speaker details</summary>
        <form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="intent" value="edit-speaker" />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              Full name
              <input
                name="fullName"
                defaultValue={speaker.name === speaker.email ? "" : speaker.name}
                maxLength={255}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <label className="block text-sm">
              Pronouns
              <input
                name="pronouns"
                defaultValue={speaker.pronouns ?? ""}
                maxLength={100}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <label className="block text-sm">
              Title
              <input
                name="title"
                defaultValue={speaker.title ?? ""}
                maxLength={255}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <label className="block text-sm">
              Company
              <input
                name="company"
                defaultValue={speaker.company ?? ""}
                maxLength={255}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
          </div>
          <label className="block text-sm" htmlFor="admin-speaker-bio">
            Biography
          </label>
          <BioEditor
            id="admin-speaker-bio"
            name="bio"
            defaultValue={speaker.bio ?? ""}
            maxLength={BIO_MAX}
          />
          <button type="submit" className={buttonClass("primary")}>
            Save speaker details
          </button>
        </form>
      </details>

      <section className={CARD} data-testid="speaker-submissions">
        <h3 className="mb-2 text-sm font-semibold tracking-wide text-gray-500 uppercase">
          Submissions ({abstracts.length})
        </h3>
        {abstracts.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing submitted yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {abstracts.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-mono text-xs text-gray-500">{row.friendlyId ?? "—"}</span>
                <a className={linkClass} href={detailUrl(row.id, row.status, null)}>
                  {row.title}
                </a>
                <StatusPill status={row.status} />
                <span className="text-sm text-gray-500">
                  {[row.trackName, row.formatName].filter(Boolean).join(" · ")}
                  {row.isPrimary ? "" : ` · ${row.role.replace(/_/g, " ")}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {program.length ? (
          <p className="mt-3 text-xs text-gray-500">
            Also on {program.length} program session{program.length === 1 ? "" : "s"}:{" "}
            {program.map((row) => row.title).join("; ")}
          </p>
        ) : null}
      </section>

      <section className={CARD} data-testid="speaker-files">
        <h3 className="mb-2 text-sm font-semibold tracking-wide text-gray-500 uppercase">
          Files ({files.reduce((sum, file) => sum + file.versions.length, 0)})
        </h3>
        {files.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing uploaded yet. Deliverables this speaker uploads from their portal appear
            here, and across the whole event in the{" "}
            <a className={linkClass} href="/admin/files">
              Files library
            </a>
            .
          </p>
        ) : (
          <>
            <ul className="space-y-4">
              {files.map((file) => (
                <li key={file.rootId} data-testid="file-chain" data-root-id={file.rootId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {file.filename}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {file.purpose} · {file.versions.length} version
                      {file.versions.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <FileVersions versions={file.versions} />
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gray-500">
              Every file across the event lives in the{" "}
              <a className={linkClass} href="/admin/files">
                Files library
              </a>
              , where you can comment on one or bulk-download a selection.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

export default function AdminSpeakerDetail({ loaderData, actionData }: Route.ComponentProps) {
  return <SpeakerView {...loaderData} actionData={actionData} />;
}
