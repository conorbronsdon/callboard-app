import { createRequestHandler } from "react-router";

import { resolveEmbedExportResponse } from "~/lib/embeds.server";
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
    /*
     * The embed widgets' JSON/XML export has to be handed back here, before
     * React Router ever sees the request. Those routes also export a default
     * component (they render HTML the rest of the time), and a single-fetch
     * document load always renders a matched leaf's component around
     * whatever its loader returns — a `Response.json(...)`/XML `Response`
     * gets folded into `loaderData` instead of sent back verbatim, so the
     * export silently turned into the widget's normal HTML page (or 500'd
     * once the merged data didn't match what the component expected). See
     * `resolveEmbedExportResponse`'s doc comment for the full mechanism.
     */
    const embedExport = await resolveEmbedExportResponse(new URL(request.url));
    if (embedExport) return withSecurityHeaders(embedExport, request.url);
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
