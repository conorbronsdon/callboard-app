/**
 * Per-test database wiring.
 *
 *   const ctx = installTestDb();      // beforeEach
 *   ...
 *   ctx.close();                      // afterEach
 *
 * After `installTestDb()`, `getDb()` inside application code returns a drizzle
 * handle over the in-memory SQLite database — no mocking of app modules.
 */
import { getDb, type DB } from "~/db/client.server";

import { createTestD1, type TestD1 } from "./d1";
import { env, resetEnv } from "./workers-env";

export interface TestDbContext extends TestD1 {
  db: DB;
}

export function installTestDb(overrides: Record<string, unknown> = {}): TestDbContext {
  resetEnv();
  const d1 = createTestD1();
  env.DB = d1.binding;
  // Deterministic secrets so signed cookies/tokens are stable and the dev
  // fallback warning in env.server.ts stays out of the test output.
  env.SESSION_SECRET = "test-session-secret";
  env.MAGIC_LINK_SECRET = "test-magic-link-secret";
  env.RATE_LIMIT_SECRET = "test-rate-limit-secret";
  Object.assign(env, overrides);

  return { ...d1, db: getDb() };
}
