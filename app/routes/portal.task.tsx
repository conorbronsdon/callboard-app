/**
 * Portal → Task detail. One task, start to finish.
 *
 * A task is completed in one of two ways:
 *  - **manual** — the speaker ticks it off ("Confirm your slot").
 *  - **form** — the task embeds a portal form (`tasks.form_id`), which the
 *    speaker fills in here; answers land in `tasks.response` and completing the
 *    form completes the task.
 *
 * ⚠️ There is no `tasks.kind` column, so the kind is DERIVED from `form_id`.
 * That is deliberate rather than lazy: file collection is modelled as a form
 * with a `file` question, which means one flow covers manual tasks, questionnaires
 * and file requests. A `kind` column is on the schema-request list all the same.
 */
import { Form, Link, useNavigation } from "react-router";
import { and, eq } from "drizzle-orm";

import {
  Card,
  FieldLabel,
  Notice,
  StatusPill,
  buttonClass,
  inputClass,
} from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { forms, tasks, uploads } from "~/db/schema";
import { renderMarkdown } from "~/lib/markdown";
import {
  applyAnswers,
  isPastDeadline,
  readPortalSchema,
  readPortalSettings,
  validateAnswers,
  type AnswerValue,
  type PortalQuestion,
} from "~/lib/portal-form";
import { formatDueDate, relativeDue } from "~/lib/portal-progress";
import { ACCEPT_ATTRIBUTE, uploadConstraintText } from "~/lib/portal-uploads";
import { RATE_LIMIT_POLICIES, enforceRateLimit } from "~/lib/rate-limit.server";
import { portalRecordContext } from "~/lib/portal/portal.server";
import { addUploadComment, loadFileHistory, storeUpload } from "~/lib/portal/uploads.server";
import { canReadUpload } from "~/lib/portal-access";
import { FileComments, FileVersions } from "~/components/file-history";
import type { LibraryComment, LibraryVersion } from "~/lib/files-library";
import type { Route } from "./+types/portal.task";

/** Load the task, refusing anything that is not this speaker's. */
async function requireOwnTask(personId: string, eventId: string, taskId: string) {
  const row = await getDb().query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.personId, personId), eq(tasks.eventId, eventId)),
  });
  // 404 rather than 403: confirming a task id exists is itself a leak.
  if (!row) throw new Response("Task not found.", { status: 404 });
  return row;
}

/**
 * The event this page runs in is the one the TASK is in — never whichever event
 * ambient portal resolution would have picked for a bare `/portal` visit.
 *
 * The portal list links here without an `?event=`, so a multi-event speaker's
 * every task link used to 404 (SPK-09 / CNT-02). Filtering on `personId` here is
 * what authorises: someone else's task is simply not found, and no event is
 * resolved for it. See `portalRecordContext`.
 */
const taskEventId = (taskId: string) => async (personId: string) => {
  const row = await getDb().query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.personId, personId)),
    columns: { eventId: true },
  });
  return row?.eventId ?? null;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const { actor, event } = await portalRecordContext(request, taskEventId(params.taskId));
  const task = await requireOwnTask(actor.person.id, event.id, params.taskId);

  const form = task.formId
    ? ((await getDb().query.forms.findFirst({ where: eq(forms.id, task.formId) })) ?? null)
    : null;

  /*
   * File-question history (CNT-04/CNT-05). The answer holds the CURRENT upload
   * id; `loadFileHistory` walks that row's chain, so v1 stays retrievable after
   * v2 lands and the organizer's comments show up on the speaker's own page.
   */
  const response = (task.response ?? {}) as Record<string, AnswerValue>;
  const schema = form ? readPortalSchema(form.schema) : null;
  const histories: Record<string, FileHistory> = {};
  for (const question of schema?.questions ?? []) {
    if (question.type !== "file") continue;
    const answer = response[question.key];
    if (typeof answer !== "string" || !answer) continue;
    const history = await loadFileHistory(answer);
    if (!history) continue;
    histories[question.key] = {
      rootId: history.rootId,
      versions: history.versions,
      comments: history.comments,
    };
  }

  return {
    now: Date.now(),
    // The deadline belongs to the conference, not to the speaker's own clock.
    timeZone: event.timezone,
    histories,
    task: {
      id: task.id,
      title: task.title,
      descriptionHtml: renderMarkdown(task.description),
      status: task.status,
      dueAt: task.dueAt?.getTime() ?? null,
      completedAt: task.completedAt?.getTime() ?? null,
      response: (task.response ?? {}) as Record<string, AnswerValue>,
    },
    form:
      form && schema
        ? {
            id: form.id,
            name: form.name,
            schema,
            settings: readPortalSettings(form.settings),
          }
        : null,
    acceptDefault: ACCEPT_ATTRIBUTE.document,
  };
}

/** One file question's version list and thread, as the page renders them. */
export interface FileHistory {
  rootId: string;
  versions: LibraryVersion[];
  comments: LibraryComment[];
}

export async function action({ request, params }: Route.ActionArgs) {
  // The write resolves the event exactly as the loader does: a page that renders
  // under the task's event and then writes under another one is the same bug.
  const { actor, event } = await portalRecordContext(request, taskEventId(params.taskId));
  const task = await requireOwnTask(actor.person.id, event.id, params.taskId);

  /*
   * The SECOND way into `storeUpload`.
   *
   * `/api/upload` got the flood cap (#85); this route did not, and a file
   * question on a portal task reaches the same writer with no limiter at all.
   * Rejected uploads leave no row, so the storage quota does not cap the
   * attempts either — an authenticated speaker could hammer R2 through the
   * task form indefinitely.
   *
   * Same policy, and deliberately the same constant `"upload"` scope: the
   * scope is part of the `(scope, identifier_hash, window_start)` primary key
   * AND is HMAC'd into the digest, so a second scope string would be a second
   * full allowance rather than a shared one — exactly the multiplier the #85
   * fix removed. One bucket per person covers both doors.
   *
   * Placed before `request.formData()` for the reason api.upload.ts gives:
   * reject a flooder before buffering the body. That means every intent on
   * this route is charged, not only the ones carrying a file, because whether
   * a file is attached is not knowable until the body has been read — which is
   * the thing this call exists to avoid doing for an abusive caller. Charging
   * a "mark complete" click against the same 30-per-10-minutes budget is the
   * strict direction, and the alternative is a limiter that runs after the
   * 25 MB is already in memory.
   *
   * The identifier is the REAL caller, matching `uploadedById` below and
   * `requireUser` in api.upload.ts: an organizer previewing a speaker's portal
   * must not be able to spend that speaker's allowance.
   */
  const uploader = actor.impersonatedBy?.id ?? actor.person.id;
  await enforceRateLimit({
    scope: "upload",
    identifier: uploader,
    policy: RATE_LIMIT_POLICIES.apiUpload,
    message: "Too many files were uploaded. Please wait before trying again.",
  });

  const body = await request.formData();
  const intent = String(body.get("intent") ?? "");
  const db = getDb();

  if (intent === "reopen") {
    await db
      .update(tasks)
      .set({ status: "pending", completedAt: null })
      .where(eq(tasks.id, task.id));
    return { ok: "Task reopened." };
  }

  if (intent === "comment") {
    const uploadId = String(body.get("uploadId") ?? "");
    const text = String(body.get("body") ?? "").trim();
    if (!text) return { error: "Write a comment first." };

    /*
     * Authorise against the SHARED predicate, not "it is on my task page".
     * `uploadId` arrives in the POST body, so a hand-built request could name
     * any upload in the deployment; `canReadUpload` is the same check the
     * download route runs, unit-tested both directions.
     */
    const target = await db.query.uploads.findFirst({ where: eq(uploads.id, uploadId) });
    if (
      !target ||
      target.eventId !== event.id ||
      !canReadUpload(target, { id: actor.person.id, role: actor.person.role })
    ) {
      return { error: "That file is not yours to comment on." };
    }

    /*
     * Attribute the comment to whoever actually typed it. Under impersonation
     * `actor.person` is the SPEAKER, so passing it put the organizer's words in
     * the thread under the speaker's name — in a two-party thread the organizer
     * then reads back from `/admin/files`. Uploads already resolve this the
     * same way a few lines up (`uploader`), and for the same reason: the
     * identifier recorded on a write is the REAL caller.
     *
     * This is attribution only. Authorisation above still runs against
     * `actor.person`, because a preview acts with the speaker's reach.
     */
    const saved = await addUploadComment({
      uploadId,
      author: actor.impersonatedBy ?? actor.person,
      body: text,
    });
    if (!saved) return { error: "That file no longer exists." };
    return { ok: "Comment posted." };
  }

  if (intent === "complete" && !task.formId) {
    await db
      .update(tasks)
      .set({ status: "complete", completedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return { ok: "Task marked complete." };
  }

  if (intent === "submit-form" && task.formId) {
    const form = await db.query.forms.findFirst({ where: eq(forms.id, task.formId) });
    if (!form) return { error: "This task's form no longer exists. Tell the programme team." };

    const schema = readPortalSchema(form.schema);
    const settings = readPortalSettings(form.settings);
    if (isPastDeadline(settings, Date.now())) {
      return { error: "This form closed and can no longer be submitted." };
    }

    const existingAnswers = (task.response ?? {}) as Record<string, AnswerValue>;
    const submitted: Record<string, AnswerValue> = {};
    for (const question of schema.questions) {
      if (question.locked) continue;

      if (question.type === "file") {
        const file = body.get(question.key);
        if (file instanceof File && file.size > 0) {
          // The answer currently on the task IS the slot's current file, so
          // re-uploading here makes a version rather than an unrelated twin
          // (CNT-04). `storeUpload` re-validates that the prior row is the same
          // owner+purpose, so a stale or forged id cannot graft a chain.
          const priorAnswer = existingAnswers[question.key];
          const stored = await storeUpload({
            file,
            eventId: event.id,
            ownerType: task.sessionId ? "session" : "person",
            ownerId: task.sessionId ?? actor.person.id,
            purpose: question.filePurpose ?? "document",
            uploadedById: uploader,
            priorUploadId: typeof priorAnswer === "string" ? priorAnswer : null,
          });
          if (!stored.ok) return { error: stored.error };
          submitted[question.key] = stored.upload.id;
        }
        continue;
      }

      if (question.type === "checkbox") {
        submitted[question.key] = body.get(question.key) === "on";
        continue;
      }

      if (question.type === "multiselect") {
        submitted[question.key] = body.getAll(question.key).map(String);
        continue;
      }

      submitted[question.key] = String(body.get(question.key) ?? "");
    }

    const merged = applyAnswers(schema, existingAnswers, submitted);

    // Validate the MERGED answers: a file uploaded on an earlier attempt still
    // satisfies a required file question on this one.
    const issues = validateAnswers(schema, merged);
    if (issues.length > 0) {
      return { error: issues.map((issue) => issue.message).join(" "), fieldIssues: issues };
    }

    await db
      .update(tasks)
      .set({ response: merged, status: "complete", completedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return { ok: "Submitted — task complete." };
  }

  return { error: "Unknown action." };
}

export default function PortalTask({ loaderData, actionData }: Route.ComponentProps) {
  const { now, timeZone, task, form, acceptDefault, histories } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const done = task.status === "complete" || task.status === "waived";
  const overdue = !done && task.dueAt !== null && task.dueAt < now;
  const closed = form ? isPastDeadline(form.settings, now) : false;

  return (
    <div className="space-y-5">
      <p className="text-sm">
        <Link to="/portal/tasks" className="text-gray-500 underline hover:text-gray-900">
          ← All tasks
        </Link>
      </p>

      {/*
       * An overdue task looked exactly like an on-time one: a small rose pill
       * in the far corner, and the date that proves it set in the same gray as
       * "No due date". The date now carries the state itself, so the page reads
       * as late from the headline down rather than from a badge inward.
       */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {task.title}
          </h1>
          <p
            className={`mt-1.5 text-sm ${
              overdue
                ? "font-medium text-rose-700 dark:text-rose-300"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {task.dueAt === null
              ? "No due date"
              : `${overdue ? "Was due" : "Due"} ${formatDueDate(task.dueAt, timeZone)} (${relativeDue(task.dueAt, now)})`}
          </p>
        </div>
        {done ? (
          <StatusPill tone="positive" glyph="✓">
            {task.status === "waived" ? "Waived" : "Complete"}
          </StatusPill>
        ) : overdue ? (
          <StatusPill tone="negative" glyph="!">
            Overdue
          </StatusPill>
        ) : (
          <StatusPill tone="warning" glyph="○">
            To do
          </StatusPill>
        )}
      </header>

      {actionData && "error" in actionData && actionData.error ? (
        <Notice tone="error">{actionData.error}</Notice>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <Notice tone="success">{actionData.ok}</Notice>
      ) : null}

      {task.descriptionHtml ? (
        <div
          className="prose-portal rounded-xl border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-900"
          dangerouslySetInnerHTML={{ __html: task.descriptionHtml }}
        />
      ) : null}

      {form ? (
        <Card title={form.name}>
          {form.schema.description ? (
            <div
              className="prose-portal mb-4 text-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(form.schema.description) }}
            />
          ) : null}

          {closed ? (
            <Notice tone="info">This form is past its deadline and is now read-only.</Notice>
          ) : null}

          <Form method="post" encType="multipart/form-data" className="space-y-4">
            <input type="hidden" name="intent" value="submit-form" />
            <h2 className="text-sm font-semibold">{form.schema.sectionTitle}</h2>

            {form.schema.questions.map((question) => (
              <QuestionField
                key={question.key}
                question={question}
                value={task.response[question.key] ?? null}
                disabled={closed}
                acceptDefault={acceptDefault}
                history={histories[question.key]}
              />
            ))}

            {!closed ? (
              <button type="submit" className={buttonClass()} disabled={busy}>
                {busy ? "Submitting…" : done ? "Update answers" : "Submit and complete"}
              </button>
            ) : null}
          </Form>
        </Card>
      ) : (
        <Card title="Complete this task" tone="plain">
          {done ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Marked complete
                {task.completedAt ? ` on ${formatDueDate(task.completedAt, timeZone)}` : ""}.
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="reopen" />
                <button type="submit" className={buttonClass("secondary")}>
                  Reopen
                </button>
              </Form>
            </div>
          ) : (
            <Form method="post" className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="intent" value="complete" />
              <button type="submit" className={buttonClass()} disabled={busy}>
                Mark complete
              </button>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                You can reopen it afterwards if something changes.
              </p>
            </Form>
          )}
        </Card>
      )}

      {/*
        Comment threads sit OUTSIDE the answer form — a nested <form> is invalid
        HTML and the browser drops the inner one, so posting a comment would
        silently submit the whole task instead.
      */}
      {Object.entries(histories).map(([key, history]) => (
        <Card key={key} title={`Comments on ${history.versions[history.versions.length - 1]?.filename ?? "your file"}`} tone="plain">
          <FileComments rootId={history.rootId} comments={history.comments} />
        </Card>
      ))}

      {done && form ? (
        <Form method="post">
          <input type="hidden" name="intent" value="reopen" />
          <button type="submit" className={buttonClass("secondary")}>
            Reopen this task
          </button>
        </Form>
      ) : null}
    </div>
  );
}

/** Exported so the constraint copy can be asserted without a data router. */
export function QuestionField({
  question,
  value,
  disabled,
  acceptDefault,
  history,
}: {
  question: PortalQuestion;
  value: AnswerValue;
  disabled: boolean;
  acceptDefault: string;
  history?: FileHistory;
}) {
  const id = `q_${question.key}`;
  const locked = question.locked || disabled;
  const stringValue = typeof value === "string" ? value : "";
  /*
   * CNT-06: a file question states its constraints AT the control. The sentence
   * is generated from the same constants `validateUpload` rejects on, and for
   * the same `filePurpose` the answer is stored under, so the copy cannot
   * promise a limit the server does not enforce.
   *
   * An author-supplied `helpText` is PREPENDED, not substituted. Substituting
   * meant a question whose author wrote any hint at all silently lost the
   * constraint sentence, and `helpText: ""` produced no copy whatsoever.
   */
  const fileConstraint = uploadConstraintText(question.filePurpose ?? "document");
  const authoredHint = question.helpText?.trim();
  const hint =
    question.type === "file"
      ? authoredHint
        ? `${authoredHint} ${fileConstraint}`
        : fileConstraint
      : question.helpText;

  return (
    <div>
      <FieldLabel htmlFor={id} hint={hint} required={question.required}>
        {question.label}
        {question.locked ? (
          <span className="ml-2 text-xs font-normal text-gray-500" title="Set by the programme team">
            🔒 locked
          </span>
        ) : null}
      </FieldLabel>

      {question.type === "textarea" ? (
        <textarea
          id={id}
          name={question.key}
          rows={4}
          defaultValue={stringValue}
          maxLength={question.maxLength}
          disabled={locked}
          required={question.required && !locked}
          className={inputClass}
        />
      ) : question.type === "select" ? (
        <select
          id={id}
          name={question.key}
          defaultValue={stringValue}
          disabled={locked}
          required={question.required && !locked}
          className={inputClass}
        >
          <option value="">Select…</option>
          {(question.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : question.type === "multiselect" ? (
        <fieldset className="mt-1.5 space-y-1.5">
          {(question.options ?? []).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={question.key}
                value={option}
                disabled={locked}
                defaultChecked={Array.isArray(value) && value.includes(option)}
                className="h-4 w-4"
              />
              {option}
            </label>
          ))}
        </fieldset>
      ) : question.type === "checkbox" ? (
        <label className="mt-1.5 flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            name={question.key}
            defaultChecked={value === true}
            disabled={locked}
            className="h-4 w-4"
          />
          Yes
        </label>
      ) : question.type === "file" ? (
        <div className="mt-1.5 space-y-1.5">
          <input
            id={id}
            type="file"
            name={question.key}
            accept={
              question.filePurpose === "headshot" ? ACCEPT_ATTRIBUTE.headshot : acceptDefault
            }
            disabled={locked}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
          />
          {history ? (
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
                Uploading again keeps the old file and adds a new version — the newest one is
                marked Latest and is what the programme team downloads.
              </p>
              <FileVersions versions={history.versions} />
            </div>
          ) : typeof value === "string" && value ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Already uploaded —{" "}
              <a href={`/api/uploads/${value}`} className="underline" download>
                download
              </a>
              .
            </p>
          ) : null}
        </div>
      ) : (
        <input
          id={id}
          name={question.key}
          type={
            question.type === "email"
              ? "email"
              : question.type === "url"
                ? "url"
                : question.type === "number"
                  ? "number"
                  : question.type === "date"
                    ? "date"
                    : question.type === "phone"
                      ? "tel"
                      : "text"
          }
          defaultValue={stringValue}
          maxLength={question.maxLength}
          disabled={locked}
          required={question.required && !locked}
          className={inputClass}
        />
      )}
    </div>
  );
}
