import { createRequestHandler } from "react-router";

import { isDemoDeploymentExpired } from "~/lib/env.server";
import { jobsForCron, runJob } from "~/lib/jobs/registry.server";
import { withSecurityHeaders } from "~/lib/security-headers";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    if (isDemoDeploymentExpired()) {
      return withSecurityHeaders(new Response("Not found", { status: 404 }), request.url);
    }
    const response = await requestHandler(request);
    return withSecurityHeaders(response, request.url);
  },

  /**
   * Cron triggers. Does NOT fire in `wrangler dev` — use
   * `POST /admin/jobs/run?name=<job>` to run a job locally or on a preview.
   * Schedules are declared in wrangler.jsonc AND on the job definition; the
   * expression is the join key.
   */
  async scheduled(controller, _env, ctx) {
    if (isDemoDeploymentExpired()) {
      console.warn("[callboard] expired disposable demo skipped scheduled work.");
      return;
    }
    const context = {
      now: new Date(controller.scheduledTime),
      trigger: "cron" as const,
      cron: controller.cron,
    };

    const due = jobsForCron(controller.cron);
    if (due.length === 0) {
      console.warn(`[callboard] cron "${controller.cron}" fired with no matching job.`);
      return;
    }

    ctx.waitUntil(
      Promise.all(
        due.map(async (job) => {
          const result = await runJob(job.name, context);
          console.log(`[callboard] cron ${job.name}: ${result.message}`);
        }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
