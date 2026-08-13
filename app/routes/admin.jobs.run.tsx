import { requireAdmin } from "~/lib/auth/auth.server";
import { JOB_NAMES, runJob } from "~/lib/jobs/registry.server";
import type { Route } from "./+types/admin.jobs.run";

/**
 * Resource route: `POST /admin/jobs/run?name=<job>`, admin session required.
 * The manual trigger for every scheduled job — see app/lib/jobs/registry.server.ts.
 *
 * POST only. Running a job is a side effect and must not be reachable by a
 * prefetcher following a GET.
 */
export async function loader() {
  throw new Response("Use POST.", { status: 405, headers: { allow: "POST" } });
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);

  const name = new URL(request.url).searchParams.get("name");
  if (!name) {
    return Response.json(
      { ok: false, message: `Pass ?name=<job>. Known jobs: ${JOB_NAMES.join(", ")}.` },
      { status: 400 },
    );
  }

  const result = await runJob(name, { now: new Date(), trigger: "manual", request });
  return Response.json({ job: name, ...result }, { status: result.ok ? 200 : 400 });
}
