import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { action as readinessAction, loader as readinessLoader } from "~/routes/public.ready";
import { installTestDb, type TestDbContext } from "~/test/db";
import { env } from "~/test/workers-env";

import { checkRuntimeReadiness } from "./readiness.server";

let ctx: TestDbContext;

beforeEach(() => {
  ctx = installTestDb();
});
afterEach(() => ctx.close());

async function withoutExpectedError<T>(operation: () => Promise<T>): Promise<T> {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return await operation();
  } finally {
    error.mockRestore();
  }
}

describe("runtime readiness — must fire", () => {
  it.each(["SESSION_SECRET", "MAGIC_LINK_SECRET", "RATE_LIMIT_SECRET"] as const)(
    "fails closed when %s is absent",
    async (name) => {
      delete env[name];
      expect(await withoutExpectedError(() => checkRuntimeReadiness())).toEqual({
        ready: false,
      });
    },
  );

  it("fails closed when the rate-limit migration is unavailable", async () => {
    ctx.sqlite.exec("DROP TABLE rate_limit_windows");

    expect(await withoutExpectedError(() => checkRuntimeReadiness())).toEqual({
      ready: false,
    });
  });

  it("returns a generic 503 without disclosing the missing dependency", async () => {
    delete env.RATE_LIMIT_SECRET;

    const response = await withoutExpectedError(() => readinessLoader());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(body)).toEqual({ ready: false });
    expect(body).not.toMatch(/secret|rate.?limit|database|d1/i);
  });
});

describe("runtime readiness — must NOT fire", () => {
  it("passes without inserting, updating, or deleting limiter rows", async () => {
    ctx.sqlite
      .prepare(
        `INSERT INTO rate_limit_windows
           (scope, identifier_hash, window_start, window_count, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("sentinel", "opaque-hash", 100, 7, 200);

    const before = ctx.sqlite
      .prepare("SELECT * FROM rate_limit_windows ORDER BY scope")
      .all();

    expect(await checkRuntimeReadiness()).toEqual({ ready: true });

    const after = ctx.sqlite
      .prepare("SELECT * FROM rate_limit_windows ORDER BY scope")
      .all();
    expect(after).toEqual(before);
  });

  it("rejects mutation methods with 405", async () => {
    const response = await readinessAction();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("returns a no-store 200 for healthy dependencies", async () => {
    const response = await readinessLoader();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/application\/json/i);
    expect(await response.json()).toEqual({ ready: true });
  });
});
