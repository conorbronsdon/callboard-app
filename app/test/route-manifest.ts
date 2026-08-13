/**
 * Shared route-manifest helpers for llms.txt-style agent-facing routes.
 *
 * Both the platform `/llms.txt` and the per-event `/e/:slug/llms.txt` route
 * pin the same invariant: every path the rendered body names must resolve
 * against the REAL route manifest imported from `app/routes.ts`, so renaming
 * or deleting a route fails a test instead of shipping an agent a dead link.
 * This is the one place that logic lives — a second hand-copied version would
 * only need to drift once for both routes' "no dead links" guarantee to go
 * quietly false.
 */
import routes from "~/routes";

type RouteEntry = { path?: string; index?: boolean; children?: RouteEntry[] };

/** `app/routes.ts` -> every registered path, children joined onto their parent. */
function flatten(entries: readonly RouteEntry[], prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    // An index route has no `path` of its own: it IS the parent's path.
    const full = entry.path ? [prefix, entry.path].filter(Boolean).join("/") : prefix;
    out.push(full);
    if (entry.children) out.push(...flatten(entry.children, full));
  }
  return out;
}

const REGISTERED = flatten(routes as RouteEntry[]).map((path) => `/${path}`.replace(/\/{2,}/g, "/"));

/**
 * Does a path written in an agent-facing doc resolve to a registered route?
 * Compared segment-wise so a manifest `:param` accepts either a concrete
 * value (a seeded id/slug) or the same `:param` written literally in the doc.
 */
export function resolves(listed: string): boolean {
  const want = listed.split("/").filter(Boolean);
  return REGISTERED.some((pattern) => {
    const have = pattern.split("/").filter(Boolean);
    if (have.length !== want.length) return false;
    return have.every((segment, i) => segment.startsWith(":") || segment === want[i]);
  });
}

/** Every `/…` token in the body, trailing sentence punctuation removed. */
export function pathsIn(body: string): string[] {
  const found = body.match(/(?<=^|[\s(])\/[A-Za-z0-9:._/-]*/gm) ?? [];
  return [...new Set(found.map((raw) => raw.replace(/[.,;:)]+$/, "")))];
}
