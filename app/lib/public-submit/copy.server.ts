import { sanitizeHtml } from "~/lib/sanitize-html";

export interface SanitizedAdminCopy {
  /** Kept for the existing escaped-paragraph renderer when there is no markup. */
  plainText: string | null;
  /** Safe HTML produced on read; raw admin HTML never enters the render prop. */
  sanitizedHtml: string | null;
}

const HTML_TAG = /<\/?[a-z][^>]*>/i;

/**
 * Preserve the public form's plain-text paragraph behavior, but route actual
 * markup through the same allowlist sanitizer as resource pages.
 */
export function sanitizeAdminCopy(body: string | null): SanitizedAdminCopy {
  if (!body?.trim()) return { plainText: null, sanitizedHtml: null };
  if (!HTML_TAG.test(body)) return { plainText: body, sanitizedHtml: null };

  const sanitizedHtml = sanitizeHtml(body).html;
  return {
    plainText: null,
    sanitizedHtml: sanitizedHtml || null,
  };
}
