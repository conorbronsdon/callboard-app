/**
 * Turn organizer-entered social handles and bare domains into safe links.
 *
 * `people.links` previously went straight into `href`, so a common `@handle`
 * became an admin-relative route and arbitrary schemes became executable link
 * targets. Unknown JSON values return `null` so callers can preserve the label
 * as read-only text without inventing a destination or dropping operator data.
 */
export function socialHref(raw: string): string | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value) return null;

  // Existing web URLs are deliberately passed through byte-for-byte: URL
  // parsing would normalize scheme case, encoding, and sometimes trailing `/`.
  if (/^https?:\/\//i.test(value)) return value;

  const handle = /^@([A-Za-z0-9_.]+)$/.exec(value);
  if (handle) return `https://x.com/${handle[1]}`;

  /*
   * This is an allowlist, not a catalogue of dangerous schemes. Requiring a
   * dotted host with no whitespace excludes relative paths, prose, `data:`,
   * `javascript:`, protocol-relative URLs, and future schemes by default.
   */
  if (/^(?:www\.)?[^\s./:?#]+(?:\.[^\s./:?#]+)+(?:[/?#][^\s]*)?$/.test(value)) {
    return `https://${value}`;
  }

  return null;
}
