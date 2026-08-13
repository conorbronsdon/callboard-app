/**
 * The ONE public-API envelope.
 *
 * Sessionboard returns two different shapes for the same resource — POST search
 * gives `{results, pagination:{currentPage,…}}`, the CRUD-proxy GET gives
 * `{data, pagination:{current_page,…}}` (research/sessionboard-api.md §8.2).
 * DECISIONS.md #5: we ship the `{results, pagination}` shape EVERYWHERE and do
 * not reproduce the inconsistency. Clients written against their POST search
 * work unmodified; clients written against their GET proxy get one shape to fix
 * instead of two to branch on.
 *
 * Pure — no bindings, no I/O, no drizzle. Unit-testable in plain Node.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/** Sessionboard caps `page` at 999; so do we, so a client cannot walk forever. */
export const MAX_PAGE = 999;

export interface Pagination {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalResults: number;
}

export interface Envelope<T> {
  results: T[];
  pagination: Pagination;
}

export interface Paging {
  page: number;
  pageSize: number;
  /** Rows to skip — `(page - 1) * pageSize`. */
  offset: number;
}

/**
 * Coerce a page/pageSize pair from anywhere (query string, JSON body) into a
 * safe window.
 *
 * Everything out of range CLAMPS rather than 400s: an integration that asks for
 * `pageSize=5000` wants as much as it can get, and a 400 there is a worse
 * developer experience than 100 rows. Garbage (`"abc"`, `null`, `-3`) falls back
 * to the default, because guessing is better than paging by NaN.
 */
export function parsePaging(input: {
  page?: unknown;
  pageSize?: unknown;
  page_size?: unknown;
}): Paging {
  const page = clampInt(input.page, 1, MAX_PAGE, 1);
  const pageSize = clampInt(
    input.pageSize ?? input.page_size,
    1,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** Wrap a page of rows with its pagination block. */
export function envelope<T>(results: T[], totalResults: number, paging: Paging): Envelope<T> {
  return {
    results,
    pagination: {
      currentPage: paging.page,
      pageSize: paging.pageSize,
      // A zero-row collection is ONE empty page, not zero pages: clients that
      // loop `while (page <= totalPages)` must still make the first request.
      totalPages: Math.max(1, Math.ceil(totalResults / paging.pageSize)),
      totalResults,
    },
  };
}

/**
 * Every `/v1` route builds its response through this one function — GET, POST,
 * PUT, DELETE and errors alike — so the default `cache-control` here is the
 * one place that governs the whole surface (#201: an authenticated GET response
 * with no cache-control leaves a shared cache free to apply HTTP heuristic
 * freshness, RFC 9111 §4.2.2, and reuse one key's response for another).
 * `private, no-store` matches the house convention for authenticated content
 * elsewhere (app/routes/admin.files.download.ts). A route with a legitimate
 * reason to differ — v1.openapi.ts is unauthenticated and cacheable — passes
 * its own `cache-control` in `headers`, which wins because it spreads last.
 */
export function apiJson(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...headers,
    },
  });
}

/**
 * Sessionboard's error body: `{ error: "<ErrorName>", message: "<prose>" }`
 * (research/sessionboard-api.md §1). Same shape here so a client's error
 * handling ports over.
 */
export function apiError(status: number, error: string, message: string): Response {
  return apiJson({ error, message }, status);
}

/** Read a JSON body, tolerating an empty one (a bare POST search means "no filters"). */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
