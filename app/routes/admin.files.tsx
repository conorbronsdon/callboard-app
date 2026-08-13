/**
 * `/admin/files` — every file uploaded across the event, in one place.
 *
 * Before this route existed the only way an organizer could see a deliverable
 * was to impersonate the speaker who uploaded it, one speaker at a time
 * (CNT-13, SPK-10). The library is deliberately grouped by DELIVERABLE rather
 * than by row: re-uploading `slides.pdf` makes a new version, and a flat table
 * would show two identically-named rows with no way to tell which one the AV
 * team should take (CNT-04).
 *
 * Authorisation is server-side and total: `requireAdmin` throws 403 before any
 * query runs, and every download link points at `/api/uploads/:id`, which
 * re-checks `canReadUpload` on its own. Nothing here is masked in the UI — a
 * non-admin never receives the loader data at all.
 */
import { redirect } from "react-router";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { Card, EmptyState, Notice, buttonClass, inputClass } from "~/components/portal-ui";
import { chunkForBind, getDb } from "~/db/client.server";
import { people, sessions, uploadComments, uploads } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import {
  buildLibrary,
  downloadRefusalText,
  fileTimestamp,
  librarySummary,
  type LibraryChain,
  type LibraryComment,
  type LibraryRow,
} from "~/lib/files-library";
import { addUploadComment } from "~/lib/portal/uploads.server";
import type { Route } from "./+types/admin.files";

const PAGE = "/admin/files";
/** The ZIP lives on its own resource route; see that module for why. */
const DOWNLOAD = "/admin/files/download";
const BUTTON = buttonClass("primary");
const SMALL = buttonClass("secondary", "sm");

/** Rows the table will render. Anything past this is reported, not hidden. */
const LIBRARY_ROW_LIMIT = 500;

export interface FilesData {
  eventName: string | null;
  chains: LibraryChain[];
  summary: string;
  /**
   * How many upload rows the event has in total. Equal to the rendered count
   * unless the window truncated, and the header says so when it did — a page
   * that silently drops rows past 500 under-reports the library AND can hide a
   * chain's v1, which reads on screen as a deliverable with fewer versions than
   * it has.
   */
  totalRows: number;
  renderedRows: number;
  /** A refused bulk download, redirected back here by the download route. */
  downloadError?: string;
}

export function meta() {
  return [{ title: "Files — callboard" }];
}

/** The library's rows, already joined for the three names the table shows. */
async function libraryRows(eventId: string): Promise<LibraryRow[]> {
  const ownerPerson = alias(people, "owner_person");
  const rows = await getDb()
    .select({
      id: uploads.id,
      versionOf: uploads.versionOf,
      version: uploads.version,
      filename: uploads.filename,
      contentType: uploads.contentType,
      purpose: uploads.purpose,
      sizeBytes: uploads.sizeBytes,
      createdAt: uploads.createdAt,
      ownerType: uploads.ownerType,
      ownerId: uploads.ownerId,
      uploaderName: people.fullName,
      uploaderEmail: people.email,
      sessionTitle: sessions.title,
      ownerPersonName: ownerPerson.fullName,
      ownerPersonEmail: ownerPerson.email,
    })
    .from(uploads)
    .leftJoin(people, eq(people.id, uploads.uploadedById))
    .leftJoin(sessions, eq(sessions.id, uploads.ownerId))
    .leftJoin(ownerPerson, eq(ownerPerson.id, uploads.ownerId))
    .where(eq(uploads.eventId, eventId))
    .orderBy(desc(uploads.createdAt))
    .limit(LIBRARY_ROW_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    versionOf: row.versionOf,
    version: row.version,
    filename: row.filename,
    contentType: row.contentType,
    purpose: row.purpose,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.getTime(),
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    uploaderName: row.uploaderName?.trim() || row.uploaderEmail || null,
    // `sessions` and `owner_person` are both joined on `owner_id`, so exactly
    // one of them is meaningful per row — `ownerType` decides which.
    sessionTitle: row.ownerType === "session" ? row.sessionTitle : null,
    ownerPersonName:
      row.ownerType === "person" ? row.ownerPersonName?.trim() || row.ownerPersonEmail : null,
  }));
}

async function commentsByRoot(rootIds: string[]): Promise<Map<string, LibraryComment[]>> {
  const grouped = new Map<string, LibraryComment[]>();
  if (rootIds.length === 0) return grouped;

  /*
   * D1 rejects a statement carrying more than MAX_BOUND_PARAMS (100) bound
   * parameters. `rootIds` is one parameter per DELIVERABLE and the window above
   * is 500 rows, so an event with more than ~100 distinct chains — roughly
   * eleven speakers at `OWNER_UPLOAD_QUOTA.maxFiles` — took the whole loader
   * down with `D1_ERROR: too many SQL variables`. Not a degraded page: a 500.
   *
   * The unit suite cannot see this on rows alone. `app/test/d1.ts` runs on
   * node:sqlite, whose parameter ceiling is ~32k, so the statement D1 rejects
   * passes locally — the same trap documented in
   * `app/lib/review/commit.bound-params.test.ts`. The wire-level assertion is
   * in `admin.files.bound-params.test.ts`.
   *
   * Chunking is safe for the ORDER because each root id lands in exactly one
   * chunk, so every thread is still read oldest-first within its own bucket.
   * The concatenation across chunks is not sorted, and does not need to be —
   * `grouped` is keyed by root and nothing reads the flat list.
   */
  const db = getDb();
  const rows = (
    await Promise.all(
      chunkForBind(rootIds, 1).map((chunk) =>
        db
          .select()
          .from(uploadComments)
          .where(inArray(uploadComments.uploadId, chunk))
          .orderBy(asc(uploadComments.createdAt), asc(uploadComments.id)),
      ),
    )
  ).flat();

  for (const row of rows) {
    const bucket = grouped.get(row.uploadId) ?? [];
    bucket.push({
      id: row.id,
      authorName: row.authorName,
      body: row.body,
      createdAt: row.createdAt.getTime(),
    });
    grouped.set(row.uploadId, bucket);
  }
  return grouped;
}

export async function loader({ request }: Route.LoaderArgs): Promise<FilesData> {
  // First statement in the route: a non-admin gets 403 before a single row of
  // file metadata is read, let alone serialised into the page.
  await requireAdmin(request);
  const event = await currentEvent(request);
  const url = new URL(request.url);
  // The download route redirects its refusals back here; it has no page of its
  // own to render one into. Unknown codes yield null rather than being echoed.
  const downloadError =
    downloadRefusalText(
      url.searchParams.get("download"),
      Number(url.searchParams.get("bytes")) || 0,
    ) ?? undefined;

  if (!event) {
    return {
      eventName: null,
      chains: [],
      summary: librarySummary([]),
      totalRows: 0,
      renderedRows: 0,
      downloadError,
    };
  }

  const rows = await libraryRows(event.id);
  // The chain roots are known from the rows alone (`version_of ?? id`), so the
  // comment fetch needs no extra round trip against the uploads table.
  const comments = await commentsByRoot([
    ...new Set(rows.map((row) => row.versionOf ?? row.id)),
  ]);
  const chains = buildLibrary(rows, comments);

  // Counted, not inferred from `rows.length === LIBRARY_ROW_LIMIT`: an event
  // sitting exactly on the limit is not truncated, and guessing would tell the
  // organizer files are missing when none are.
  const [{ total }] = await getDb()
    .select({ total: count() })
    .from(uploads)
    .where(eq(uploads.eventId, event.id));

  return {
    eventName: event.name,
    chains,
    summary: librarySummary(chains),
    totalRows: total,
    renderedRows: rows.length,
    downloadError,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "Choose an event first." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const db = getDb();

  if (intent === "comment") {
    const uploadId = String(form.get("uploadId") ?? "");
    const body = String(form.get("body") ?? "").trim();
    if (!body) return { ok: false as const, error: "Write a comment first." };

    // Scope the target to THIS event before writing. An admin is an admin of a
    // deployment, so without this an id from another event would be commentable.
    const target = await db.query.uploads.findFirst({ where: eq(uploads.id, uploadId) });
    if (!target || target.eventId !== event.id) {
      return { ok: false as const, error: "That file is not part of this event." };
    }

    const saved = await addUploadComment({ uploadId, author: admin, body });
    if (!saved) return { ok: false as const, error: "That file no longer exists." };
    return redirect(`${PAGE}?commented=1`);
  }

  /*
   * `bulk-download` is deliberately NOT handled here. This route has a
   * component, so anything it returns is serialised as `actionData` — a
   * `Response` carrying ZIP bytes gets read with `response.text()` on the way
   * out and never reaches the browser as a file. The archive is served from
   * `/admin/files/download`, a resource route; see that module for the
   * mechanism and the browser proof.
   */
  return { ok: false as const, error: "Unknown action." };
}

function VersionRow({ version }: { version: LibraryChain["versions"][number] }) {
  return (
    <li
      data-testid="file-version"
      data-version={version.version}
      data-latest={version.isLatest ? "true" : "false"}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
    >
      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
        v{version.version}
      </span>
      {version.isLatest ? (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
          Latest
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{version.filename}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{version.sizeLabel}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {fileTimestamp(version.createdAt)}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400">by {version.uploaderName}</span>
      <a className="text-sm underline" href={version.href} download>
        Download
      </a>
    </li>
  );
}

function ChainCard({ chain }: { chain: LibraryChain }) {
  return (
    <div
      data-testid="file-chain"
      data-root-id={chain.rootId}
      className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <label className="flex items-center gap-2 text-base font-medium">
            <input
              type="checkbox"
              name="uploadIds"
              value={chain.latest.id}
              form="bulk-download-form"
              aria-label={`Select ${chain.filename}`}
              className="h-4 w-4"
            />
            <span className="truncate">{chain.filename}</span>
          </label>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {chain.linkageKind === "session" ? "Session" : "Speaker"}: {chain.linkageLabel} ·
            uploaded by {chain.latest.uploaderName} · {fileTimestamp(chain.latest.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200">
            {chain.versions.length} version{chain.versions.length === 1 ? "" : "s"}
          </span>
          <a className={SMALL} href={chain.latest.href} download>
            Download latest
          </a>
        </div>
      </div>

      <ul className="mt-3 divide-y divide-gray-200 dark:divide-gray-800">
        {[...chain.versions].reverse().map((version) => (
          <VersionRow key={version.id} version={version} />
        ))}
      </ul>

      <details className="mt-3" data-testid="file-comments">
        <summary className="cursor-pointer text-sm font-medium">
          Comments ({chain.comments.length})
        </summary>
        <ul className="mt-2 space-y-2">
          {chain.comments.map((comment) => (
            <li
              key={comment.id}
              data-testid="file-comment"
              className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
            >
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {comment.authorName} · {fileTimestamp(comment.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
          {chain.comments.length === 0 ? (
            <li className="text-sm text-gray-600 dark:text-gray-400">
              No comments yet. The speaker sees anything you write here on their own file.
            </li>
          ) : null}
        </ul>
        <form method="post" className="mt-3 space-y-2">
          <input type="hidden" name="intent" value="comment" />
          <input type="hidden" name="uploadId" value={chain.rootId} />
          <label className="grid gap-1 text-sm">
            Add a comment
            <textarea className={inputClass} name="body" rows={2} maxLength={2000} />
          </label>
          <button className={SMALL} type="submit">
            Post comment
          </button>
        </form>
      </details>
    </div>
  );
}

export function FilesScreen({
  eventName,
  chains,
  summary,
  totalRows,
  renderedRows,
  downloadError,
  actionError,
}: FilesData & { actionError?: string }) {
  const error = actionError ?? downloadError;
  const truncated = totalRows > renderedRows;
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Files</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Every file uploaded for {eventName ?? "this event"} — decks, documents and headshots,
          with their version history. {summary}
        </p>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {truncated ? (
        <div data-testid="files-truncated">
          <Notice tone="info">
            Showing the {renderedRows} newest files of {totalRows}. Older uploads are not on this
            page, and a deliverable whose first version falls outside the window shows fewer
            versions here than it has.
          </Notice>
        </div>
      ) : null}

      {chains.length === 0 ? (
        <div data-testid="admin-files-empty">
          <EmptyState title="No files have been uploaded yet.">
            Files speakers upload from their portal — task deliverables, decks and headshots —
            appear here with the session or speaker they belong to.
          </EmptyState>
        </div>
      ) : (
        <Card title="Upload library" tone="plain">
          {/*
            Posts to the resource route, NOT to this page's action: a UI route
            cannot return a file body to a browser. `id` is what the per-chain
            checkboxes attach to via their `form=` attribute, so they travel
            with this submission even though they sit outside the element.
          */}
          <form
            method="post"
            action={DOWNLOAD}
            id="bulk-download-form"
            className="mb-4 flex flex-wrap gap-2"
          >
            <button className={BUTTON} type="submit">
              Generate download
            </button>
            <span className="self-center text-sm text-gray-600 dark:text-gray-400">
              Tick the files you need; the ZIP holds the latest version of each.
            </span>
          </form>
          <div className="space-y-3">
            {chains.map((chain) => (
              <ChainCard key={chain.rootId} chain={chain} />
            ))}
          </div>
        </Card>
      )}

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Looking for one speaker&rsquo;s files? Open their record from{" "}
        <a className="underline" href="/admin/speakers">
          Speakers
        </a>
        .
      </p>
    </div>
  );
}

export default function AdminFiles({ loaderData, actionData }: Route.ComponentProps) {
  const error =
    actionData && "ok" in actionData && actionData.ok === false ? actionData.error : undefined;
  return <FilesScreen {...loaderData} actionError={error} />;
}
