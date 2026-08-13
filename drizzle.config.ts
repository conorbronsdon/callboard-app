import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated as plain SQLite DDL into `app/db/migrations/` and
 * applied by wrangler (`npm run migrate` / `npm run migrate:remote`), which is
 * why there is no `dbCredentials` block — drizzle-kit never talks to D1 here.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./app/db/schema.ts",
  out: "./app/db/migrations",
  verbose: true,
  strict: true,
});
