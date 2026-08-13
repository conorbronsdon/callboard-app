/**
 * Cross-check: the v1 API surface both agent-facing docs advertise
 * (`/llms.txt`'s "Coverage:" line and `/e/:slug/llms.txt`'s per-endpoint
 * bullets) against `API_OPERATIONS` in `~/lib/api/catalogue` — the SAME
 * catalogue that already feeds `/v1/openapi.json` and `/developers`, and is
 * already pinned to `app/routes.ts` by `api-catalogue.test.ts` (see that
 * file's header). That makes API_OPERATIONS a trustworthy stand-in for "the
 * real v1 surface, derived from app/routes.ts + the v1 route modules":
 * re-deriving it a SECOND time here, by re-parsing routes.ts or grepping
 * every v1.*.ts module's method dispatch by hand, would just be a second
 * hand-copy of the same fact with its own fresh chance to drift.
 *
 * The specific rot this closes (#204): both llms files once claimed
 * "speakers ... update" when v1.speaker.ts is GET-only (loader handles GET;
 * `action` unconditionally returns `methodNotAllowed(["GET"])`). Neither
 * llms.txt.test.ts nor public.llms.test.ts caught it, because both suites
 * lean on `~/test/route-manifest`'s `resolves()`, which only proves a PATH
 * exists — it is blind to which HTTP verbs that path actually accepts. This
 * file adds the missing verb-level check, plus its mirror: a resource that
 * ships in API_OPERATIONS but is never named in the platform-wide
 * `/llms.txt` map at all.
 *
 * Deliberately does NOT try to verify every real verb is documented (that
 * would fail today on a pre-existing, legitimate gap — "delete" is never
 * spelled out even though sessions supports it via "restore"'s counterpart).
 * It verifies the narrower, checkable thing: every verb a doc claims is
 * real, and every negation a doc claims ("no update") is really absent.
 */
import { describe, expect, it } from "vitest";

import { API_OPERATIONS } from "~/lib/api/catalogue";
import { installTestDb } from "~/test/db";
import { EVENT_SLUG, seedDemoFixture } from "~/test/fixtures";

import { loader as llmsTxtLoader } from "~/routes/llms.txt";
import { loader as publicLlmsLoader } from "~/routes/public.llms";

type PublicLlmsLoaderArgs = Parameters<typeof publicLlmsLoader>[0];

/* ------------------------------------------------------- derive the truth */

/** operationId's leading verb, e.g. "searchSessions" -> "search". */
const VERB_PREFIX_RE = /^(list|search|get|create|update|delete|restore|bulk)/;

/** Doc prose word -> the operationId verb prefix(es) that back it. "list" has
 * no distinct operation anywhere in this API — the search endpoint with
 * empty filters IS the list — so a "list" claim is satisfied by either a
 * "list" or a "search" operation. "remove" is a prose synonym for delete. */
const CLAIM_TO_PREFIXES: Record<string, string[]> = {
  list: ["list", "search"],
  search: ["search"],
  get: ["get"],
  create: ["create"],
  "bulk create": ["bulk"],
  update: ["update"],
  restore: ["restore"],
  delete: ["delete"],
  remove: ["delete"],
};

/** "session"/"sessions" -> "sessions", the word the docs actually use. */
const RESOURCE_WORD: Record<string, string> = {
  event: "events",
  events: "events",
  session: "sessions",
  sessions: "sessions",
  speaker: "speakers",
  speakers: "speakers",
};

/** operationId -> its resource key, or null for the generic metadata handler
 * (tracks/rooms/tags/formats/levels — already drift-tested against
 * METADATA_FAMILIES by api-catalogue.test.ts; out of scope here). */
function resourceKeyOf(operationId: string): string | null {
  const m = VERB_PREFIX_RE.exec(operationId);
  if (!m) return null;
  const rest = operationId.slice(m[0].length).toLowerCase();
  if (rest.startsWith("metadata")) return null;
  return RESOURCE_WORD[rest] ?? null;
}

/** resource key -> the set of verb PREFIXES it really supports, derived from
 * API_OPERATIONS (not hand-maintained). */
function actualSurface(operations: typeof API_OPERATIONS): Map<string, Set<string>> {
  const byResource = new Map<string, Set<string>>();
  for (const op of operations) {
    const key = resourceKeyOf(op.operationId);
    if (!key) continue;
    const m = VERB_PREFIX_RE.exec(op.operationId);
    if (!m) continue;
    if (!byResource.has(key)) byResource.set(key, new Set());
    byResource.get(key)!.add(m[0].toLowerCase());
  }
  return byResource;
}

/** Does `resourceKey` really support the claimed prose verb? Throws — rather
 * than silently returning false — on a verb word with no rule, because a
 * checker that can't recognize a claim must not report it as fine. */
function supports(byResource: Map<string, Set<string>>, resourceKey: string, claimVerb: string): boolean {
  const prefixes = CLAIM_TO_PREFIXES[claimVerb];
  if (!prefixes) {
    throw new Error(
      `llms-api-surface: no rule for verb "${claimVerb}" — teach CLAIM_TO_PREFIXES or fix the doc line that uses it.`,
    );
  }
  const actual = byResource.get(resourceKey);
  if (!actual) return false;
  return prefixes.some((p) => actual.has(p));
}

/* ------------------------------------------------------------- doc parse */

interface Claim {
  resource: string;
  positive: string[];
  negated: string[];
}

/** Join a template string's wrapped continuation lines (2+ leading spaces)
 * back onto the logical line they wrap, matching this repo's own
 * indentation convention for these two files' source. */
function logicalLines(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s{2,}\S/.test(line) && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

/**
 * "list, search, get (read-only, no update)" or "list, search, get —
 * read-only, no update" -> { positive: [...], negated: [...] }. Both
 * punctuation forms appear in the repo today (llms.txt.ts uses the em dash,
 * public.llms.ts the parenthetical), so both are parsed.
 */
function parseVerbClaim(raw: string): { positive: string[]; negated: string[] } {
  const dashParts = raw.split(/\s+—\s+/);
  let positivePart = dashParts[0];
  let negationText = dashParts.slice(1).join(" — ");

  const parenMatch = positivePart.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (parenMatch) {
    positivePart = parenMatch[1];
    negationText = negationText ? `${negationText}, ${parenMatch[2]}` : parenMatch[2];
  }

  const positive = positivePart
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const negated = [...negationText.matchAll(/\bno\s+([a-z][a-z ]*?)(?:,|$)/gi)].map((m) => m[1].trim());
  return { positive, negated };
}

/** Every "<resource> (<verb, verb, ...>)" pair in llms.txt.ts's Coverage
 * line. Returns null if no "Coverage:" line can be found at all — the doc's
 * format changed enough that this checker cannot see it. */
function coverageClaims(body: string): Claim[] | null {
  const line = logicalLines(body).find((l) => l.includes("Coverage:"));
  if (!line) return null;
  const after = line.slice(line.indexOf("Coverage:") + "Coverage:".length);
  const claims: Claim[] = [];
  for (const m of after.matchAll(/([a-z][a-z ]*?)\s*\(([^)]*)\)/gi)) {
    claims.push({ resource: m[1].trim().toLowerCase(), ...parseVerbClaim(m[2]) });
  }
  return claims;
}

/** Every "- /v1/event/<id>/<resource> — <verb, verb, ...>" bullet in
 * public.llms.ts. A bullet whose text after the dash is not a lowercase
 * comma-separated verb list (the metadata-family bullet is prose, not a verb
 * claim) is skipped rather than misparsed. Returns null if no `/v1/event/`
 * bullet exists at all. */
function bulletClaims(body: string): Claim[] | null {
  const lines = logicalLines(body).filter((l) => /^- \/v1\/event\/\S+\//.test(l));
  if (lines.length === 0) return null;
  const claims: Claim[] = [];
  for (const line of lines) {
    const m = /^- \/v1\/event\/\S+\/([a-z]+) — (.+)$/.exec(line);
    if (!m) continue;
    const [, resource, rest] = m;
    if (!/^[a-z][a-z ,]*(\(|—|$)/.test(rest)) continue; // prose, not a verb claim
    claims.push({ resource, ...parseVerbClaim(rest) });
  }
  return claims;
}

/** All problems found in `claims` against `byResource`; empty = consistent.
 * `null` claims (doc format unrecognized) is itself a problem — never a
 * silent pass. */
function claimProblems(
  claims: Claim[] | null,
  byResource: Map<string, Set<string>>,
  sourceLabel: string,
): string[] {
  if (claims === null) {
    return [`${sourceLabel}: could not locate any endpoint-verb claims — the doc format changed`];
  }
  const problems: string[] = [];
  for (const claim of claims) {
    for (const verb of claim.positive) {
      if (!supports(byResource, claim.resource, verb)) {
        problems.push(
          `${sourceLabel}: claims "${claim.resource}" supports "${verb}", but no matching v1 operation exists in API_OPERATIONS`,
        );
      }
    }
    for (const verb of claim.negated) {
      if (supports(byResource, claim.resource, verb)) {
        problems.push(
          `${sourceLabel}: claims "${claim.resource}" does NOT support "${verb}", but API_OPERATIONS has a matching operation now — the doc is stale in the other direction`,
        );
      }
    }
  }
  return problems;
}

/* -------------------------------------------------------------- fixtures */

async function renderLlmsTxt(): Promise<string> {
  return (await llmsTxtLoader()).text();
}

async function renderPublicLlms(): Promise<string> {
  const ctx = installTestDb();
  try {
    await seedDemoFixture(ctx.db);
    const args = {
      request: new Request(`https://x.test/e/${EVENT_SLUG}/llms.txt`),
      params: { slug: EVENT_SLUG },
      context: {},
    } as unknown as PublicLlmsLoaderArgs;
    const response = (await publicLlmsLoader(args)) as Response;
    return response.text();
  } finally {
    ctx.close();
  }
}

/* ---------------------------------------------------------------- tests */

describe("agent-facing v1 API surface vs API_OPERATIONS", () => {
  const byResource = actualSurface(API_OPERATIONS);

  it("GUARD THE GUARD: API_OPERATIONS actually maps to resources sessions/speakers/events", () => {
    // A resourceKeyOf regression that returned null for everything would make
    // every claim below vacuously "unsupported: false" for the wrong reason.
    expect([...byResource.keys()].sort()).toEqual(["events", "sessions", "speakers"]);
    expect([...(byResource.get("sessions") ?? [])].sort()).toEqual(
      ["bulk", "create", "delete", "get", "restore", "search", "update"].sort(),
    );
    expect([...(byResource.get("speakers") ?? [])].sort()).toEqual(["get", "search"].sort());
  });

  it("REAL: llms.txt.ts's Coverage line makes no false verb claims", async () => {
    const body = await renderLlmsTxt();
    const claims = coverageClaims(body);
    expect(claims, "could not find the Coverage: line — did the wording change?").not.toBeNull();
    expect(claims!.length, "found the Coverage line but extracted zero resource claims").toBeGreaterThan(0);
    expect(claimProblems(claims, byResource, "llms.txt.ts")).toEqual([]);
  });

  it("REAL: public.llms.ts's per-endpoint bullets make no false verb claims", async () => {
    const body = await renderPublicLlms();
    const claims = bulletClaims(body);
    expect(claims, "could not find any /v1/event/.../<resource> — <verbs> bullet").not.toBeNull();
    expect(claims!.length, "found bullets but extracted zero resource claims").toBeGreaterThan(0);
    expect(claimProblems(claims, byResource, "public.llms.ts")).toEqual([]);
  });

  it("MUST FIRE: the #204 bug — reintroducing the false speaker-update claim goes red", () => {
    const fakeLlmsTxt =
      "- Coverage: events; sessions (list, search, create, bulk create, get, update, " +
      "restore); speakers (list, search, get, update); and the shared metadata " +
      "families tracks, rooms, tags, formats, and levels.";
    const problems = claimProblems(coverageClaims(fakeLlmsTxt), byResource, "llms.txt.ts");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('"speakers"') && p.includes('"update"'))).toBe(true);

    const fakePublicLine = "- /v1/event/abc-123/speakers — list, search, get, update";
    const publicProblems = claimProblems(bulletClaims(fakePublicLine), byResource, "public.llms.ts");
    expect(publicProblems.length).toBeGreaterThan(0);
    expect(publicProblems.some((p) => p.includes('"speakers"') && p.includes('"update"'))).toBe(true);
  });

  it("MUST NOT FIRE: the true claim that sessions DOES support update stays green", () => {
    const fakeLlmsTxt = "- Coverage: sessions (update, delete, restore); speakers (get, search).";
    expect(claimProblems(coverageClaims(fakeLlmsTxt), byResource, "llms.txt.ts")).toEqual([]);
  });

  it("MUST FIRE: a doc still claiming 'no update' after an update operation ships goes red", () => {
    const withFakeUpdate = new Map(byResource);
    withFakeUpdate.set("speakers", new Set([...(byResource.get("speakers") ?? []), "update"]));
    const claims = coverageClaims("- Coverage: speakers (list, search, get — read-only, no update).");
    expect(claimProblems(claims, withFakeUpdate, "llms.txt.ts")).toEqual([
      'llms.txt.ts: claims "speakers" does NOT support "update", but API_OPERATIONS has a matching operation now — the doc is stale in the other direction',
    ]);
  });

  it("MUST NOT FIRE: the real 'no update' negation for speakers is currently true", () => {
    const claims = coverageClaims("- Coverage: speakers (list, search, get — read-only, no update).");
    expect(claimProblems(claims, byResource, "llms.txt.ts")).toEqual([]);
  });

  it("NEGATIVE CONTROL: an unrecognized verb word fails loudly instead of silently passing", () => {
    expect(() => supports(byResource, "sessions", "reticulate")).toThrow(/no rule for verb/);
  });

  it("NEGATIVE CONTROL: a body with no recognizable claim shape reports a problem, not a silent []", () => {
    expect(claimProblems(coverageClaims("Nothing about coverage here."), byResource, "llms.txt.ts")).toEqual([
      "llms.txt.ts: could not locate any endpoint-verb claims — the doc format changed",
    ]);
    expect(claimProblems(bulletClaims("No v1 bullets here."), byResource, "public.llms.ts")).toEqual([
      "public.llms.ts: could not locate any endpoint-verb claims — the doc format changed",
    ]);
  });

  it("the metadata-family bullet's prose is not misparsed as a verb claim", () => {
    const line =
      "- /v1/event/abc-123/tracks — one of the shared metadata families; the same " +
      "event-scoped pattern also covers rooms, tags, formats, and levels";
    expect(bulletClaims(line)).toEqual([]);
  });

  it("no v1 resource is missing from the platform-wide /llms.txt map", async () => {
    const body = await renderLlmsTxt();
    const resourceKeys = new Set(API_OPERATIONS.map((op) => resourceKeyOf(op.operationId)).filter((k) => k !== null));
    // Guard the guard: a derivation that found nothing would pass vacuously.
    expect(resourceKeys.size).toBeGreaterThan(0);
    const missing = [...resourceKeys].filter((key) => !new RegExp(`\\b${key}\\b`, "i").test(body));
    expect(missing).toEqual([]);
  });

  it("MUST FIRE: a resource in API_OPERATIONS but absent from the map is caught", () => {
    const resourceKeys = ["sessions", "speakers", "sponsors"]; // "sponsors" is not a real resource
    const body = "Coverage: events; sessions (list); speakers (get); and the shared metadata families.";
    const missing = resourceKeys.filter((key) => !new RegExp(`\\b${key}\\b`, "i").test(body));
    expect(missing).toEqual(["sponsors"]);
  });
});
