/**
 * The version list and comment thread for one uploaded file.
 *
 * Shared on purpose (CNT-04, CNT-05): the organizer's library and the
 * speaker's portal must show the SAME versions and the SAME thread, and two
 * hand-written copies would drift the moment one side gained a field. The
 * organizer's `/admin/files` uses its own richer card; this component is the
 * speaker-side surface, and both read the same `versions`/`comments` shapes.
 */
import { buttonClass, inputClass } from "~/components/portal-ui";
import { fileTimestamp, type LibraryComment, type LibraryVersion } from "~/lib/files-library";

export function FileVersions({ versions }: { versions: LibraryVersion[] }) {
  if (versions.length === 0) return null;
  return (
    <ul
      data-testid="file-version-list"
      className="divide-y divide-gray-200 text-sm dark:divide-gray-800"
    >
      {[...versions].reverse().map((version) => (
        <li
          key={version.id}
          data-testid="file-version"
          data-version={version.version}
          data-latest={version.isLatest ? "true" : "false"}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
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
          <a className="underline" href={version.href} download>
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * One thread per file, shown to whichever side is looking.
 *
 * `rootId` is the chain root, so a comment written against v1 is still the
 * same conversation after v2 lands.
 */
export function FileComments({
  rootId,
  comments,
  disabled = false,
}: {
  rootId: string;
  comments: LibraryComment[];
  disabled?: boolean;
}) {
  return (
    <div data-testid="file-comments" className="mt-3 space-y-2">
      <h3 className="text-sm font-semibold">Comments ({comments.length})</h3>
      <ul className="space-y-2">
        {comments.map((comment) => (
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
        {comments.length === 0 ? (
          <li className="text-sm text-gray-600 dark:text-gray-400">
            No comments yet. Anything you write here is visible to the programme team.
          </li>
        ) : null}
      </ul>
      {disabled ? null : (
        <form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="comment" />
          <input type="hidden" name="uploadId" value={rootId} />
          <label className="grid gap-1 text-sm">
            Add a comment
            <textarea className={inputClass} name="body" rows={2} maxLength={2000} />
          </label>
          <button className={buttonClass("secondary", "sm")} type="submit">
            Post comment
          </button>
        </form>
      )}
    </div>
  );
}
