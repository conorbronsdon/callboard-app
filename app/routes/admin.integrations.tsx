/**
 * Admin → Integrations. The Accelevents surface and the Airtable mirror.
 *
 * DECISIONS.md #24: Accelevents ships as an in-product page with visible sync
 * history, not a bare download link — "one-way native integration" is a
 * required feature, and two anonymous CSV buttons do not read as one.
 *
 * The page is honest about the thing that matters: their API cannot associate a
 * speaker with a session (research/accelevents-api.md §5 — 47 session fields,
 * zero speaker fields, every join endpoint a genuine 404). So the CSV PAIR is
 * the complete path on every tier, and the API push is an optional accelerator
 * that still leaves the linking to the pair. Saying that on the page is better
 * product judgment than shipping a push that silently half-works.
 *
 * Router-free markup, like the rest of the admin surface.
 */
import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import {
  accelConfig,
  buildAccelCsvPair,
  pushToAccelevents,
} from "~/lib/integrations/accelevents.server";
import { airtableConfig, runAirtableMirror } from "~/lib/integrations/airtable.server";
import { historyOf, readSyncState, type SyncRun } from "~/lib/integrations/sync-state.server";
import { webhookDriver } from "~/lib/webhooks/config.server";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  setWebhookActive,
  type DeliveryView,
  type WebhookView,
} from "~/lib/webhooks/webhooks.server";
import type { Route } from "./+types/admin.integrations";

export interface IntegrationsData {
  event: { id: string; name: string } | null;
  accelevents: {
    apiConfigured: boolean;
    speakerRows: number;
    sessionRows: number;
    skipped: { title: string; reason: string }[];
    blankCells: { email: string; columns: string[] }[];
    lastSyncedAt: string | null;
    lastError: string | null;
    history: SyncRun[];
  };
  airtable: {
    configured: boolean;
    lastSyncedAt: string | null;
    lastError: string | null;
    cursor: string | null;
    history: SyncRun[];
  };
  webhooks: {
    driver: "builtin" | "svix";
    endpoints: WebhookView[];
    deliveries: DeliveryView[];
  };
}

export interface IntegrationsAction {
  ok: boolean;
  message: string;
  mintedWebhook?: { url: string; secret: string };
}

const fmt = (value: Date | null | undefined) =>
  value ? value.toISOString().slice(0, 16).replace("T", " ") : null;

/**
 * "Delivered" is honest only where we actually have that evidence. The
 * built-in driver gets a 2xx from the real receiving endpoint, so a success
 * row there IS a delivery. Svix mode only tells us the handoff to Svix was
 * accepted -- Svix's own downstream fan-out is outside what Callboard can
 * observe -- so that row says "accepted," never "delivered." Same house rule
 * that shipped for comms mail status (#178): say only what we actually know.
 */
function deliveryStatusLabel(delivery: Pick<DeliveryView, "driver" | "status">): string {
  if (delivery.status === "failed") return "Failed";
  return delivery.driver === "svix" ? "Accepted by Svix" : "Delivered";
}

export function meta() {
  return [{ title: "Integrations — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs): Promise<IntegrationsData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  const driver = webhookDriver();
  const [endpoints, deliveries] = await Promise.all([
    driver === "builtin" ? listWebhooks() : Promise.resolve([]),
    listWebhookDeliveries(),
  ]);

  if (!event) {
    return {
      event: null,
      accelevents: {
        apiConfigured: Boolean(accelConfig()),
        speakerRows: 0,
        sessionRows: 0,
        skipped: [],
        blankCells: [],
        lastSyncedAt: null,
        lastError: null,
        history: [],
      },
      airtable: {
        configured: Boolean(airtableConfig()),
        lastSyncedAt: null,
        lastError: null,
        cursor: null,
        history: [],
      },
      webhooks: { driver, endpoints, deliveries },
    };
  }

  const [pair, accelState, airtableState] = await Promise.all([
    buildAccelCsvPair(event.id),
    readSyncState(event.id, "accelevents"),
    readSyncState(event.id, "airtable"),
  ]);

  return {
    event: { id: event.id, name: event.name },
    accelevents: {
      apiConfigured: Boolean(accelConfig()),
      speakerRows: pair.speakers.rowCount,
      sessionRows: pair.sessions.rowCount,
      skipped: pair.sessions.skipped,
      blankCells: pair.speakers.blankCells,
      lastSyncedAt: fmt(accelState?.lastSyncedAt),
      lastError: accelState?.lastError ?? null,
      history: historyOf(accelState),
    },
    airtable: {
      configured: Boolean(airtableConfig()),
      lastSyncedAt: fmt(airtableState?.lastSyncedAt),
      lastError: airtableState?.lastError ?? null,
      cursor: airtableState?.cursor ?? null,
      history: historyOf(airtableState),
    },
    webhooks: { driver, endpoints, deliveries },
  };
}

export async function action({ request }: Route.ActionArgs): Promise<IntegrationsAction> {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const driver = webhookDriver();

  if (intent === "webhook-create") {
    if (driver === "svix") {
      return { ok: false, message: "Webhook endpoints are managed in Svix while that driver is configured." };
    }
    const created = await createWebhook(String(formData.get("url") ?? ""));
    return created.ok
      ? {
          ok: true,
          message: "Webhook created.",
          mintedWebhook: { url: created.webhook.url, secret: created.secret },
        }
      : { ok: false, message: created.error };
  }

  if (intent === "webhook-toggle") {
    if (driver === "svix") {
      return { ok: false, message: "Webhook endpoints are managed in Svix while that driver is configured." };
    }
    const active = String(formData.get("active") ?? "") === "1";
    const changed = await setWebhookActive(String(formData.get("webhookId") ?? ""), active);
    return changed
      ? { ok: true, message: active ? "Webhook enabled." : "Webhook disabled." }
      : { ok: false, message: "That webhook no longer exists." };
  }

  if (intent === "webhook-delete") {
    if (driver === "svix") {
      return { ok: false, message: "Webhook endpoints are managed in Svix while that driver is configured." };
    }
    const deleted = await deleteWebhook(String(formData.get("webhookId") ?? ""));
    return deleted
      ? { ok: true, message: "Webhook deleted; its delivery history was retained." }
      : { ok: false, message: "That webhook no longer exists." };
  }

  const event = await currentEvent(request);
  if (!event) return { ok: false, message: "No event exists yet. Create one in Settings first." };

  if (intent === "accelevents-push") {
    const config = accelConfig();
    if (!config) {
      return {
        ok: false,
        message:
          "Accelevents API is not configured. Set ACCELEVENTS_API_KEY and ACCELEVENTS_EVENT_URL, or use the CSV pair (which is the only path that links speakers to sessions).",
      };
    }
    const result = await pushToAccelevents({ eventId: event.id, config });
    return { ok: result.ok, message: result.message };
  }

  if (intent === "airtable-mirror") {
    const result = await runAirtableMirror();
    return { ok: result.ok, message: result.message };
  }

  return { ok: false, message: `Unknown intent "${intent}".` };
}

const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");
const PANEL = "rounded-lg border border-gray-200 p-4 dark:border-gray-800";
const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";

function History({ runs }: { runs: SyncRun[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        No sync history yet. Every push to a connected tool is logged here with its result, so you
        can see what left callboard and when.
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-xs">
      {runs.map((run, index) => (
        <li key={`${run.at}-${index}`} className="flex flex-wrap gap-2">
          <span className="font-mono text-gray-500">{run.at.slice(0, 16).replace("T", " ")}</span>
          <span className={run.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
            {run.ok ? "ok" : "failed"}
          </span>
          <span className="font-mono text-gray-500">{run.action}</span>
          <span className="text-gray-600 dark:text-gray-300">{run.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function IntegrationsScreen({
  data,
  result,
}: {
  data: IntegrationsData;
  result?: IntegrationsAction;
}) {
  const accel = data.accelevents;
  const airtable = data.airtable;
  const webhookData = data.webhooks;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold">Integrations</h2>
        <p className="text-sm text-gray-500">
          One-way pushes out of callboard. Nothing here ever blocks a speaker or admin
          write.
        </p>
      </div>

      {result ? (
        <p
          data-integration-result
          className={`rounded border p-2 text-sm ${
            result.ok
              ? "border-green-500 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100"
              : "border-red-400 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          {result.message}
        </p>
      ) : null}

      {result?.mintedWebhook ? (
        <div
          data-minted-webhook-secret
          className="rounded-lg border border-green-500 bg-green-50 p-3 dark:bg-green-950"
        >
          <p className="text-sm font-medium">
            Webhook for “{result.mintedWebhook.url}” created. Copy its secret now — this
            is the only time it is shown.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-white p-2 font-mono text-xs dark:bg-gray-900">
            {result.mintedWebhook.secret}
          </pre>
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
            Callboard retains the secret server-side so it can sign future deliveries,
            but no later list or read response returns it.
          </p>
        </div>
      ) : null}

      {!data.event ? (
        <p className={PANEL}>
          No event yet. Create one in Settings first.
        </p>
      ) : null}

      {/* ── Accelevents ─────────────────────────────────────────────── */}
      <section className={PANEL} data-panel="accelevents">
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h3 className="text-lg font-semibold">Sync to Accelevents</h3>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">
            {accel.apiConfigured ? "CSV pair + API push" : "CSV pair"}
          </span>
          {accel.lastSyncedAt ? (
            <span className="text-xs text-gray-500">last sync {accel.lastSyncedAt}</span>
          ) : (
            <span className="text-xs text-gray-500">never synced</span>
          )}
        </div>

        <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
          Download both files and import them in order: <strong>Speakers → Actions →
          Import Speakers</strong> first, then <strong>Agenda → Actions → Import
          Sessions</strong>. The session file carries speaker <em>emails</em>, so the pair
          creates the sessions <em>and</em> links the speakers in one pass — no Accelevents
          ids needed on a first run.
        </p>

        <div className="mb-3 flex flex-wrap gap-2">
          <a className={BUTTON} href="/admin/integrations/accelevents.csv?file=speakers">
            speakers.csv ({accel.speakerRows} rows)
          </a>
          <a className={BUTTON} href="/admin/integrations/accelevents.csv?file=sessions">
            sessions.csv ({accel.sessionRows} rows)
          </a>
          <form method="post">
            <input type="hidden" name="intent" value="accelevents-push" />
            <button type="submit" className={GHOST} disabled={!accel.apiConfigured}>
              Push via API
            </button>
          </form>
        </div>

        <p className="mb-3 rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <strong>Their API cannot link a speaker to a session.</strong> The session body has
          47 fields and none of them reference a speaker; the speaker body has 20 and none
          reference a session. So the API push creates records but leaves the agenda
          unlinked — the CSV pair is the complete path, on every Accelevents tier. API
          access is Enterprise-only;{" "}
          {accel.apiConfigured
            ? "a key is configured here."
            : "no key is configured, so the push button is off."}
        </p>

        {accel.skipped.length > 0 ? (
          <details className="mb-3 text-xs" data-accel-skipped>
            <summary className="cursor-pointer">
              {accel.skipped.length} session(s) left out of sessions.csv
            </summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {accel.skipped.map((row) => (
                <li key={row.title}>
                  <span className="font-medium">{row.title}</span> — {row.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {accel.blankCells.length > 0 ? (
          <details className="mb-3 text-xs" data-accel-blanks>
            <summary className="cursor-pointer">
              {accel.blankCells.length} speaker row(s) have blank cells — blanks DELETE on
              re-import
            </summary>
            <p className="mt-1 pl-4 text-gray-600 dark:text-gray-300">
              Accelevents deletes existing values for any blank column on the speaker
              import (the session import does the opposite and preserves them). Fill these
              in before a second upload, or the data already in Accelevents is wiped.
            </p>
            <ul className="mt-1 space-y-0.5 pl-4">
              {accel.blankCells.map((row) => (
                <li key={row.email}>
                  <span className="font-mono">{row.email}</span> — {row.columns.join(", ")}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {accel.lastError ? (
          <p className="mb-2 text-xs text-red-700 dark:text-red-400">
            Last error: {accel.lastError}
          </p>
        ) : null}
        <History runs={accel.history} />
      </section>

      {/* ── Airtable ────────────────────────────────────────────────── */}
      <section className={PANEL} data-panel="airtable">
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h3 className="text-lg font-semibold">Airtable mirror</h3>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">
            {airtable.configured ? "configured" : "not configured"}
          </span>
          {airtable.lastSyncedAt ? (
            <span className="text-xs text-gray-500">last sync {airtable.lastSyncedAt}</span>
          ) : null}
        </div>

        {airtable.configured ? (
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
            Speakers, sessions and submissions are pushed to your base every 30 minutes,
            upserting on the <code className="font-mono">Callboard ID</code> column. The
            watermark only advances on a clean run, so a failed batch is retried on the
            next one rather than lost.
          </p>
        ) : (
          <p
            data-airtable-unconfigured
            className="mb-3 text-sm text-gray-600 dark:text-gray-300"
          >
            Not configured. Add the <code className="font-mono">AIRTABLE_TOKEN</code> and{" "}
            <code className="font-mono">AIRTABLE_BASE</code> secrets to your deployment and
            the mirror starts on the next cron tick. Until then this job is a no-op — callboard works fine
            without it, and D1 stays the source of truth either way.
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form method="post">
            <input type="hidden" name="intent" value="airtable-mirror" />
            <button type="submit" className={GHOST}>
              Run mirror now
            </button>
          </form>
          <span className="text-xs text-gray-500">
            or <code className="font-mono">POST /admin/jobs/run?name=airtable-mirror</code>{" "}
            — cron never fires in local dev.
          </span>
        </div>

        {airtable.cursor ? (
          <p className="mb-2 text-xs text-gray-500">
            Watermark: {new Date(Number(airtable.cursor)).toISOString()}
          </p>
        ) : null}
        {airtable.lastError ? (
          <p className="mb-2 text-xs text-red-700 dark:text-red-400">
            Last error: {airtable.lastError}
          </p>
        ) : null}
        <History runs={airtable.history} />
      </section>

      <section className={PANEL} data-panel="webhooks">
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h3 className="text-lg font-semibold">Webhooks</h3>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">
            {webhookData.driver === "svix" ? "Svix configured" : "built-in delivery"}
          </span>
        </div>

        {webhookData.driver === "svix" ? (
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
            Delivery is managed by Svix. Configure endpoints and subscriptions in the{" "}
            <a className="underline" href="https://app.svix.com/">
              Svix dashboard
            </a>
            ; Callboard records whether each handoff to Svix succeeded.
          </p>
        ) : (
          <>
            <form method="post" className="mb-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="intent" value="webhook-create" />
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs">
                HTTPS endpoint
                <input
                  className={FIELD}
                  type="url"
                  name="url"
                  required
                  placeholder="https://example.com/callboard-webhooks"
                />
              </label>
              <button type="submit" className={BUTTON}>Add webhook</button>
            </form>

            {webhookData.endpoints.length === 0 ? (
              <p data-empty-webhooks className="mb-4 rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
                No webhook endpoints yet. Writes continue normally; delivery is a no-op.
              </p>
            ) : (
              <ul className="mb-4 space-y-2">
                {webhookData.endpoints.map((webhook) => (
                  <li key={webhook.id} className="flex flex-wrap items-center gap-2 rounded border border-gray-200 p-2 dark:border-gray-800">
                    <span className="min-w-64 flex-1 break-all font-mono text-xs">{webhook.url}</span>
                    <span className="text-xs text-gray-500">{webhook.active ? "active" : "disabled"}</span>
                    <form method="post">
                      <input type="hidden" name="intent" value="webhook-toggle" />
                      <input type="hidden" name="webhookId" value={webhook.id} />
                      <input type="hidden" name="active" value={webhook.active ? "0" : "1"} />
                      <button type="submit" className={GHOST}>{webhook.active ? "Disable" : "Enable"}</button>
                    </form>
                    <form method="post">
                      <input type="hidden" name="intent" value="webhook-delete" />
                      <input type="hidden" name="webhookId" value={webhook.id} />
                      <button type="submit" className={GHOST}>Delete</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <h4 className="mb-2 text-sm font-semibold">Recent deliveries</h4>
        {webhookData.deliveries.length === 0 ? (
          <p data-empty-webhook-deliveries className="text-xs text-gray-500">No deliveries attempted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className={eyebrowClass}>
                <tr>
                  <th className="pb-2 pr-3">Event</th>
                  <th className="pb-2 pr-3">Resource</th>
                  <th className="pb-2 pr-3">Driver</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Attempts</th>
                  <th className="pb-2">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {webhookData.deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td className="py-2 pr-3 font-mono text-xs">{delivery.event}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{delivery.resourceId}</td>
                    <td className="py-2 pr-3">{delivery.driver}</td>
                    <td className="py-2 pr-3" title={delivery.lastError ?? undefined}>
                      {deliveryStatusLabel(delivery)}
                    </td>
                    <td className="py-2 pr-3">{delivery.attempts}</td>
                    <td className="py-2 text-xs text-gray-500">{fmt(delivery.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function AdminIntegrations({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <IntegrationsScreen
      data={loaderData}
      result={actionData as IntegrationsAction | undefined}
    />
  );
}
