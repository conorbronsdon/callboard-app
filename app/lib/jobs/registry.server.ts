/**
 * Scheduled-job registry.
 *
 * Cron triggers DO NOT fire in `wrangler dev`. So every job is a plain exported
 * function registered here, reachable two ways:
 *   - production:  the Worker `scheduled` handler (workers/app.ts)
 *   - any env:     POST /admin/jobs/run?name=<job>   (admin-authenticated)
 *
 * That second path is how a job gets tested at all, and how the orchestrator
 * verifies one on a deployed preview. A job that is only reachable from cron is
 * a job nobody has ever run.
 */
import { runAirtableMirror } from "~/lib/integrations/airtable.server";

export interface JobContext {
  now: Date;
  trigger: "cron" | "manual";
  /** Cron expression that fired, when trigger === "cron". */
  cron?: string;
  /**
   * The request that triggered a MANUAL run, when there was one. Jobs that put
   * links in email take their origin from it — a preview deploy and production
   * share `APP_URL`, so a job run from a preview would otherwise mail out links
   * into production (the same trap `appUrl()` documents). Absent under cron,
   * which has no incoming URL and falls back to `APP_URL`.
   */
  request?: Request;
}

export interface JobResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export type Job = (context: JobContext) => Promise<JobResult>;

export interface JobDefinition {
  name: string;
  description: string;
  /** Cron expression this job answers to, if any. Must exist in wrangler.jsonc. */
  cron?: string;
  run: Job;
}

/**
 * WS5. The body lives in app/lib/comms/reminders.server.ts; the registration
 * and the route are unchanged. Imported lazily so this registry — which the
 * `/admin/jobs` PAGE imports to list job names — does not drag the mailer, the
 * template loader and drizzle's query builder into that page's bundle.
 */
const taskReminders: JobDefinition = {
  name: "task-reminders",
  description:
    "Email speakers whose portal tasks are due within 7 days or already past due. One reminder per task per 3 days.",
  cron: "0 15 * * *",
  async run(context) {
    const { runTaskReminders } = await import("~/lib/comms/reminders.server");
    return runTaskReminders(context);
  },
};

/**
 * WS7. The mirror is one-way and cron-driven (DECISIONS.md #2): Airtable's
 * 5 req/s cap must never sit on a user write, so nothing on a request path
 * calls it. Runs cleanly with no credentials — the "not configured" branch is
 * the fresh-clone default, not an error.
 */
const airtableMirror: JobDefinition = {
  name: "airtable-mirror",
  description: "Push speakers/submissions/sessions to the Airtable mirror base.",
  cron: "*/30 * * * *",
  async run(context) {
    const result = await runAirtableMirror({ now: context.now });
    return {
      ok: result.ok,
      message: result.message,
      details: {
        ...result.details,
        trigger: context.trigger,
        at: context.now.toISOString(),
      },
    };
  },
};

/**
 * The mirror's preflight. Deliberately has NO cron.
 *
 * Two reasons it runs on demand only. It writes to an external surface — it
 * creates tables and fields in the operator's base — and per the safety
 * contract that happens because a human clicked it, not because a timer fired.
 * And it is a first-run chore: once the base matches, every later run is a
 * single GET that reports "ready". Nothing here is scheduled work.
 *
 * Creation is create-only-if-absent: no rename, no retype, no delete, and no
 * table outside MIRROR_FIELD_SPEC is ever touched. A token without
 * `schema.bases:write` still gets a useful answer — the list of what to add by
 * hand — instead of an error.
 */
const airtableSchema: JobDefinition = {
  name: "airtable-schema",
  description:
    "Check the Airtable mirror base for missing tables/fields and create any that are absent. Never alters or deletes existing ones. Run once after creating the base.",
  async run(context) {
    const { ensureAirtableSchema } = await import(
      "~/lib/integrations/airtable-schema.server"
    );
    const result = await ensureAirtableSchema({ create: true });
    return {
      ok: result.ok,
      message: result.message,
      details: {
        ...result.details,
        trigger: context.trigger,
        at: context.now.toISOString(),
      },
    };
  },
};

export const JOBS: Record<string, JobDefinition> = {
  [taskReminders.name]: taskReminders,
  [airtableMirror.name]: airtableMirror,
  [airtableSchema.name]: airtableSchema,
};

export const JOB_NAMES = Object.keys(JOBS);

export async function runJob(name: string, context: JobContext): Promise<JobResult> {
  const job = JOBS[name];
  if (!job) {
    return {
      ok: false,
      message: `Unknown job "${name}". Known jobs: ${JOB_NAMES.join(", ")}.`,
    };
  }
  try {
    return await job.run(context);
  } catch (error) {
    return {
      ok: false,
      message: `Job "${name}" threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Every job whose cron expression matches the one that fired. */
export function jobsForCron(cron: string): JobDefinition[] {
  return Object.values(JOBS).filter((job) => job.cron === cron);
}
