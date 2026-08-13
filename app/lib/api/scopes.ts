/**
 * API scopes — a PURE module, deliberately separate from `keys.server.ts`.
 *
 * The `/developers` page renders the scope list in its component body. Route
 * modules are tree-shaken for the browser bundle and every `.server.ts` import
 * is stripped, so importing `API_SCOPES` from `keys.server.ts` compiled fine,
 * server-rendered fine, and then threw `API_SCOPES is not defined` the moment
 * the page hydrated — the same class of mistake AGENTS.md flags for
 * `app/db/schema.ts`. Runtime constants a component touches live in a pure
 * module; `keys.server.ts` re-exports them so server callers have one import.
 *
 * Scope model per research/sessionboard-api.md §2: per-domain, NON-cascading.
 * `read:events` unlocks nothing else, and no read scope ever implies a write.
 */

/** Every scope the API understands. Order is the order the admin UI lists them. */
export const API_SCOPES = [
  "read:events",
  "read:sessions",
  "write:sessions",
  "read:contacts",
  "read:metadata",
  "write:metadata",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const READ_SCOPES: ApiScope[] = API_SCOPES.filter((scope) =>
  scope.startsWith("read:"),
) as ApiScope[];

/** The two presets the mint form offers. Custom combinations go via checkboxes. */
export const SCOPE_PRESETS = {
  read_only: READ_SCOPES,
  read_write: [...API_SCOPES] as ApiScope[],
} as const;
export type ScopePreset = keyof typeof SCOPE_PRESETS;

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}
