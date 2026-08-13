/**
 * The Files library's shaping rules — pure, so they can be unit-tested without
 * a database (CNT-13, CNT-04).
 *
 * The library's whole job is turning a flat `uploads` table into one entry per
 * DELIVERABLE with its version history attached. That grouping is where the
 * "Latest" marker comes from, so it is the part worth testing directly rather
 * than through a rendered page.
 */
import { formatBytes, numberVersions, rootUploadId } from "~/lib/portal-uploads";
import { MAX_ZIP_BYTES } from "~/lib/zip";

/** One `uploads` row as the loader selects it, already joined for names. */
export interface LibraryRow {
  id: string;
  versionOf: string | null;
  /** Stored 1-based chain position — see `uploads.version` on why not a date. */
  version: number;
  filename: string;
  contentType: string;
  purpose: string;
  sizeBytes: number;
  /** Epoch ms — the loader serialises Dates so the client gets a number. */
  createdAt: number;
  ownerType: string;
  ownerId: string;
  uploaderName: string | null;
  sessionTitle: string | null;
  ownerPersonName: string | null;
}

export interface LibraryVersion {
  id: string;
  version: number;
  isLatest: boolean;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sizeLabel: string;
  createdAt: number;
  uploaderName: string;
  /** Authenticated download; `api.upload.download.ts` re-checks ownership. */
  href: string;
}

export interface LibraryComment {
  id: string;
  authorName: string;
  body: string;
  createdAt: number;
}

export interface LibraryChain {
  rootId: string;
  /** The newest version's filename — what the deliverable is called today. */
  filename: string;
  purpose: string;
  linkageKind: "session" | "person" | "unknown";
  linkageLabel: string;
  latest: LibraryVersion;
  versions: LibraryVersion[];
  totalBytes: number;
  comments: LibraryComment[];
}

export function downloadHref(uploadId: string): string {
  return `/api/uploads/${uploadId}`;
}

function linkageOf(row: LibraryRow): Pick<LibraryChain, "linkageKind" | "linkageLabel"> {
  if (row.ownerType === "session") {
    return { linkageKind: "session", linkageLabel: row.sessionTitle ?? "Session (deleted)" };
  }
  if (row.ownerType === "person") {
    return { linkageKind: "person", linkageLabel: row.ownerPersonName ?? "Speaker (removed)" };
  }
  return { linkageKind: "unknown", linkageLabel: "Unattached" };
}

/**
 * Group flat upload rows into version chains, newest deliverable first.
 *
 * The chain key is `version_of ?? id`, which is exactly the predicate
 * `listUploadVersions` queries with — if these two ever disagree the library
 * would show a version count the detail view contradicts.
 */
export function buildLibrary(
  rows: LibraryRow[],
  commentsByRoot: Map<string, LibraryComment[]> = new Map(),
): LibraryChain[] {
  const chains = new Map<string, LibraryRow[]>();
  for (const row of rows) {
    const root = rootUploadId(row);
    const bucket = chains.get(root);
    if (bucket) bucket.push(row);
    else chains.set(root, [row]);
  }

  const built: LibraryChain[] = [];
  for (const [rootId, members] of chains) {
    const versions: LibraryVersion[] = numberVersions(members).map((row) => ({
      id: row.id,
      version: row.version,
      isLatest: row.isLatest,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sizeLabel: formatBytes(row.sizeBytes),
      createdAt: row.createdAt,
      uploaderName: row.uploaderName ?? "Unknown",
      href: downloadHref(row.id),
    }));
    const latest = versions[versions.length - 1];
    // Linkage comes from the newest row: a file moved between owners should
    // read as where it lives now, not where it started.
    const latestRow = members.find((row) => row.id === latest.id) ?? members[0];

    built.push({
      rootId,
      filename: latest.filename,
      purpose: latestRow.purpose,
      ...linkageOf(latestRow),
      latest,
      versions,
      totalBytes: versions.reduce((sum, version) => sum + version.sizeBytes, 0),
      comments: commentsByRoot.get(rootId) ?? [],
    });
  }

  return built.sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

/** "12 files across 9 deliverables · 40.2 MB" for the library header. */
export function librarySummary(chains: LibraryChain[]): string {
  const files = chains.reduce((sum, chain) => sum + chain.versions.length, 0);
  const bytes = chains.reduce((sum, chain) => sum + chain.totalBytes, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(files, "file")} across ${plural(chains.length, "deliverable")} · ${formatBytes(bytes)}`;
}

/** Absolute, unambiguous timestamp for a file row. */
export function fileTimestamp(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/* ------------------------------------------------- bulk-download refusals */

/**
 * Why a bulk download was refused, as a code that survives a redirect.
 *
 * The ZIP is served from a RESOURCE route (`/admin/files/download`), which has
 * no component and therefore nothing to render an error into — see the module
 * header there for why it cannot be a UI route's action. So a refusal redirects
 * back to `/admin/files?download=<code>` and the library renders the sentence.
 *
 * Codes rather than the message itself: the query string is attacker-supplied
 * on the way back in, and a page that prints whatever `?message=` says is a
 * phishing surface even when React escapes the HTML.
 */
export const DOWNLOAD_REFUSALS = ["empty", "foreign", "missing", "too-large"] as const;
export type DownloadRefusal = (typeof DOWNLOAD_REFUSALS)[number];

export function isDownloadRefusal(value: string | null): value is DownloadRefusal {
  return value !== null && (DOWNLOAD_REFUSALS as readonly string[]).includes(value);
}

/**
 * The sentence for a refusal code, or null when the code is not one of ours.
 *
 * `too-large` quotes the selection's own size and the cap from `MAX_ZIP_BYTES`
 * itself, so the number on screen cannot drift from the number that refused.
 */
export function downloadRefusalText(
  code: string | null,
  selectedBytes = 0,
): string | null {
  if (!isDownloadRefusal(code)) return null;
  switch (code) {
    case "empty":
      return "Select at least one file.";
    case "foreign":
      return "Those files are not part of this event.";
    case "missing":
      return "None of those files are still in storage.";
    case "too-large":
      return `That selection is ${formatBytes(selectedBytes)}. A single download is capped at ${formatBytes(
        MAX_ZIP_BYTES,
      )} — select fewer files.`;
  }
}
