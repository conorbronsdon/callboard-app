import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import type { RevisionSource } from "~/db/schema";
import type { SessionRevisionRow } from "~/lib/admin/session-revisions.server";

export interface RevisionEntry {
  id: string;
  title: string;
  description: string | null;
  editorName: string;
  source: RevisionSource;
  createdAt: string;
  isCurrent: boolean;
  titleChangedFrom: string | null;
  descriptionLengthDelta: number | null;
  previousDescriptionLength: number | null;
  descriptionLength: number;
}

const SOURCE_LABELS: Record<RevisionSource, string> = {
  submit: "Submitted",
  admin_edit: "Organizer edit",
  portal_edit: "Speaker edit",
  restore: "Restored",
  system: "Imported",
};

const UTC_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

/**
 * Rows are already newest-first. Comparing with the next row preserves that
 * database ordering while making each change read against the version it
 * replaced, rather than accidentally comparing it with a newer edit.
 */
export function toRevisionEntries(rows: SessionRevisionRow[]): RevisionEntry[] {
  return rows.map((row, index) => {
    const older = rows[index + 1];
    const description = row.description ?? "";
    const olderDescription = older?.description ?? "";

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      editorName: row.editorName,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      isCurrent: index === 0,
      titleChangedFrom: older && older.title !== row.title ? older.title : null,
      descriptionLengthDelta:
        older && olderDescription !== description
          ? description.length - olderDescription.length
          : null,
      previousDescriptionLength: older ? olderDescription.length : null,
      descriptionLength: description.length,
    };
  });
}

function abstractChange(entry: RevisionEntry): string | null {
  if (
    entry.descriptionLengthDelta === null ||
    entry.previousDescriptionLength === null
  ) {
    return entry.titleChangedFrom && entry.previousDescriptionLength !== null
      ? `Abstract: ${entry.descriptionLength} characters (unchanged)`
      : null;
  }

  const delta = entry.descriptionLengthDelta;
  const signedDelta = delta < 0 ? `−${Math.abs(delta)}` : `+${delta}`;
  return `Abstract: ${entry.previousDescriptionLength} → ${entry.descriptionLength} characters (${signedDelta})`;
}

export function RevisionHistory({
  entries,
  hiddenFields = {},
  canRestore,
}: {
  entries: RevisionEntry[];
  /** Hidden fields the restore form must carry (route-specific: tab, track, ...). */
  hiddenFields?: Record<string, string>;
  /** Renders the restore button. False on surfaces where restore is not offered. */
  canRestore: boolean;
}) {
  return (
    <section data-revision-history>
      <p className={eyebrowClass}>Session revisions</p>
      <h3 className="mt-1 font-semibold">Change history</h3>

      {entries.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          No content edits recorded yet.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {entries.map((entry) => {
            const change = abstractChange(entry);
            return (
              <li
                key={entry.id}
                data-revision-entry
                data-revision-id={entry.id}
                className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm">
                      <span className="font-medium">{entry.editorName}</span>
                      <span className="text-gray-600 dark:text-gray-400">
                        {" "}· {SOURCE_LABELS[entry.source]}
                      </span>
                    </p>
                    <time
                      dateTime={entry.createdAt}
                      className="text-xs text-gray-600 dark:text-gray-400"
                    >
                      {UTC_DATE_FORMAT.format(new Date(entry.createdAt))}
                    </time>
                  </div>
                  {entry.isCurrent ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700">
                      Current
                    </span>
                  ) : null}
                </div>

                {entry.titleChangedFrom ? (
                  <p data-revision-title-change className="mt-3 text-sm">
                    Title: &quot;{entry.titleChangedFrom}&quot; → &quot;{entry.title}&quot;
                  </p>
                ) : null}
                {change ? (
                  <p
                    data-revision-abstract-change
                    className="mt-1 text-sm text-gray-600 dark:text-gray-400"
                  >
                    {change}
                  </p>
                ) : null}

                <details className="mt-3 border-t border-gray-200 pt-3 text-sm dark:border-gray-800">
                  <summary className="cursor-pointer font-medium">Show full text</summary>
                  <div className="mt-2 space-y-2">
                    <p className="font-medium">{entry.title}</p>
                    <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                      {entry.description}
                    </p>
                  </div>
                </details>

                {!entry.isCurrent && canRestore ? (
                  <form method="post" className="mt-3">
                    <input type="hidden" name="intent" value="restore-revision" />
                    <input type="hidden" name="revisionId" value={entry.id} />
                    {Object.entries(hiddenFields).map(([name, value]) => (
                      <input key={name} type="hidden" name={name} value={value} />
                    ))}
                    <button
                      type="submit"
                      className={buttonClass("secondary")}
                      data-restore-revision={entry.id}
                    >
                      Restore this version
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
