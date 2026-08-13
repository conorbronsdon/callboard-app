/**
 * Drift guards for the API surface.
 *
 * Three lists have to agree or the docs lie: `API_OPERATIONS` (which feeds both
 * `/developers` and `/v1/openapi.json`), the route table in `app/routes.ts`, and
 * `METADATA_FAMILIES` in the schema. Each check below has a NEGATIVE CONTROL —
 * a path that must NOT be found — because a matcher that says yes to everything
 * would pass all of these while proving nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { METADATA_FAMILIES } from "~/db/schema";

import { API_OPERATIONS, METADATA_FAMILY_PATHS, curlFor } from "./catalogue";
import { buildOpenApiDocument } from "./openapi";
import { parsePaging, envelope, apiError, apiJson, readJsonBody } from "./envelope";

const ROUTES_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "routes.ts"),
  "utf8",
);

/** OpenAPI template -> the concrete route patterns that must be registered. */
function registeredPatterns(path: string): string[] {
  const base = path
    .replace(/^\//, "")
    .replace("{eventId}", ":eventId")
    .replace("{sessionId}", ":sessionId")
    .replace("{contactId}", ":contactId");

  if (!base.includes("{family}")) return [base];
  return METADATA_FAMILY_PATHS.map((family) => base.replace("{family}", family));
}

function isRegistered(pattern: string): boolean {
  // The families are registered from a literal array in a flatMap, so match the
  // interpolated form too.
  const interpolated = METADATA_FAMILY_PATHS.reduce<string>(
    (acc, family) => acc.replace(`/${family}`, "/${family}"),
    pattern,
  );
  return (
    ROUTES_SOURCE.includes(`route("${pattern}"`) ||
    ROUTES_SOURCE.includes(`route(\`${interpolated}\``)
  );
}

describe("catalogue vs route table", () => {
  it("every documented endpoint is a registered route", () => {
    const missing: string[] = [];
    for (const operation of API_OPERATIONS) {
      for (const pattern of registeredPatterns(operation.path)) {
        if (!isRegistered(pattern)) missing.push(`${operation.operationId} -> ${pattern}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the compatibility aliases are registered too", () => {
    expect(isRegistered("v1/event/:eventId/sessions")).toBe(true);
    expect(isRegistered("v1/event/:eventId/speakers")).toBe(true);
    expect(isRegistered("v1/openapi.json")).toBe(true);
    expect(isRegistered("developers")).toBe(true);
  });

  it("NEGATIVE CONTROL: the matcher says no to a route that does not exist", () => {
    expect(isRegistered("v1/event/:eventId/sponsors")).toBe(false);
    expect(isRegistered("v1/event/:eventId/tracks/delete")).toBe(false);
  });

  it("the documented metadata families ARE the schema's families", () => {
    expect([...METADATA_FAMILY_PATHS].sort()).toEqual([...METADATA_FAMILIES].sort());
  });
});

describe("openapi document", () => {
  const spec = buildOpenApiDocument({ origin: "https://callboard.test" }) as {
    openapi: string;
    servers: { url: string }[];
    paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
    components: { securitySchemes: Record<string, { name: string; in: string }> };
  };

  it("declares 3.1.0, the server, and the x-access-token scheme", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("https://callboard.test");
    expect(spec.components.securitySchemes.ApiKeyAuth).toMatchObject({
      name: "x-access-token",
      in: "header",
    });
  });

  it("contains one operation per catalogue entry, plus the two aliases", () => {
    const ids = Object.values(spec.paths)
      .flatMap((methods) => Object.values(methods))
      .map((operation) => operation.operationId);

    for (const operation of API_OPERATIONS) {
      expect(ids, operation.operationId).toContain(operation.operationId);
    }
    expect(ids).toContain("searchSessionsCompat");
    expect(ids).toContain("searchSpeakersCompat");
    expect(new Set(ids).size).toBe(ids.length); // operationIds are unique
  });

  it("documents 401 and 403 on every operation, and 409 on the update", () => {
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        expect(Object.keys(operation.responses), operation.operationId).toContain("401");
        expect(Object.keys(operation.responses), operation.operationId).toContain("403");
      }
    }
    expect(
      Object.keys(spec.paths["/v1/event/{eventId}/sessions/{sessionId}"].put.responses),
    ).toContain("409");
  });

  it("is JSON-serialisable without cycles or undefined leaks", () => {
    const text = JSON.stringify(spec);
    expect(text).not.toContain("undefined");
    expect(JSON.parse(text)).toBeTruthy();
  });
});

describe("curl examples", () => {
  it("substitutes the real event id and always sends the header", () => {
    const search = API_OPERATIONS.find((op) => op.operationId === "searchSessions")!;
    const line = curlFor(search, "https://callboard.test", "evt-123");
    expect(line).toContain("https://callboard.test/v1/event/evt-123/sessions/search");
    expect(line).toContain("x-access-token");
    expect(line).toContain("-d '{");
  });

  it("omits the body flag for a GET", () => {
    const get = API_OPERATIONS.find((op) => op.operationId === "listEvents")!;
    const line = curlFor(get, "https://callboard.test", "evt-123");
    expect(line).not.toContain("-d '");
    expect(line.trimEnd().endsWith("'")).toBe(true);
  });
});

describe("envelope primitives", () => {
  it("clamps, defaults and computes the offset", () => {
    expect(parsePaging({})).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(parsePaging({ page: "3", pageSize: "10" })).toEqual({
      page: 3,
      pageSize: 10,
      offset: 20,
    });
    expect(parsePaging({ pageSize: 5000 }).pageSize).toBe(100);
    expect(parsePaging({ pageSize: 0 }).pageSize).toBe(1);
    expect(parsePaging({ page: 0 }).page).toBe(1);
    expect(parsePaging({ page: 100_000 }).page).toBe(999);
    expect(parsePaging({ page: "abc", pageSize: null }).page).toBe(1);
    expect(parsePaging({ page_size: "7" }).pageSize).toBe(7);
    expect(parsePaging({ pageSize: 10.9 }).pageSize).toBe(10);
  });

  it("counts an empty collection as one page", () => {
    expect(envelope([], 0, parsePaging({}))).toEqual({
      results: [],
      pagination: { currentPage: 1, pageSize: 25, totalPages: 1, totalResults: 0 },
    });
    expect(envelope([1], 97, parsePaging({ pageSize: 25 })).pagination.totalPages).toBe(4);
  });

  it("errors use Sessionboard's {error, message} body", async () => {
    const response = apiError(429, "TooManyRequestsError", "Slow down.");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "TooManyRequestsError",
      message: "Slow down.",
    });
    expect(apiJson({}).headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("treats an empty POST body as 'no filters', but rejects a non-object", async () => {
    expect(await readJsonBody(new Request("https://x.test", { method: "POST" }))).toEqual({});
    await expect(
      readJsonBody(new Request("https://x.test", { method: "POST", body: "[1,2]" })),
    ).rejects.toThrow();
    await expect(
      readJsonBody(new Request("https://x.test", { method: "POST", body: "{not json" })),
    ).rejects.toThrow();
  });
});
