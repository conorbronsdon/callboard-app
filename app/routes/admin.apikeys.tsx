/**
 * Admin → API keys. Mint, list, revoke.
 *
 * The minted key is rendered ONCE, from `actionData`, and is never written to
 * the database, a redirect URL, or a log line — only its SHA-256 and last four
 * characters are stored. That is why minting cannot redirect: a redirect would
 * either lose the value or have to carry it in a query string, which lands in
 * browser history and every proxy log between here and the admin.
 *
 * Router-free markup (plain `<a>`, plain `<form method="post">`), like the rest
 * of the admin surface — it renders under `renderToStaticMarkup` with no router
 * context, which is what makes the render test a real page render.
 */
import { buttonClass } from "~/components/portal-ui";
import { requireAdmin } from "~/lib/auth/auth.server";
import { currentEvent } from "~/lib/event.server";
import { listApiKeys, mintApiKey, revokeApiKey } from "~/lib/api/keys.server";
// From the PURE module, not keys.server: the scope list crosses into the
// component through loader data, and a `.server` runtime import next to a
// component is one refactor away from a hydration crash (see lib/api/scopes.ts).
import { API_SCOPES, SCOPE_PRESETS, isApiScope, type ApiScope } from "~/lib/api/scopes";
import type { Route } from "./+types/admin.apikeys";

export interface ApiKeyView {
  id: string;
  name: string;
  suffix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeysData {
  event: { id: string; name: string } | null;
  keys: ApiKeyView[];
  scopes: readonly string[];
}

export interface ApiKeysAction {
  ok: boolean;
  error?: string;
  minted?: { name: string; plaintext: string; scopes: string[] };
  revoked?: string;
}

const fmt = (value: Date | null | undefined) =>
  value ? value.toISOString().slice(0, 16).replace("T", " ") : null;

export async function loader({ request }: Route.LoaderArgs): Promise<ApiKeysData> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { event: null, keys: [], scopes: API_SCOPES };

  const rows = await listApiKeys(event.id);
  return {
    event: { id: event.id, name: event.name },
    scopes: API_SCOPES,
    keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      suffix: row.keySuffix,
      scopes: row.scopes,
      createdAt: fmt(row.createdAt) ?? "",
      lastUsedAt: fmt(row.lastUsedAt),
      revokedAt: fmt(row.revokedAt),
    })),
  };
}

export async function action({ request }: Route.ActionArgs): Promise<ApiKeysAction> {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false, error: "No event exists yet. Create one in Settings first." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "mint") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false, error: "Give the key a name so you can tell it apart later." };

    const preset = String(formData.get("preset") ?? "");
    const scopes: ApiScope[] =
      preset === "read_only" || preset === "read_write"
        ? [...SCOPE_PRESETS[preset]]
        : formData.getAll("scopes").map(String).filter(isApiScope);

    if (scopes.length === 0) {
      return { ok: false, error: "Pick at least one scope — scopes do not cascade." };
    }

    const minted = await mintApiKey({ eventId: event.id, name, scopes });
    return {
      ok: true,
      minted: { name: minted.key.name, plaintext: minted.plaintext, scopes },
    };
  }

  if (intent === "revoke") {
    const keyId = String(formData.get("keyId") ?? "");
    const revoked = await revokeApiKey(event.id, keyId);
    return revoked
      ? { ok: true, revoked: keyId }
      : { ok: false, error: "That key is not on this event, or is already revoked." };
  }

  return { ok: false, error: `Unknown intent "${intent}".` };
}

const FIELD =
  "rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900";
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");

export function ApiKeysScreen({
  data,
  result,
}: {
  data: ApiKeysData;
  result?: ApiKeysAction;
}) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold">API keys</h2>
        <p className="text-sm text-gray-500">
          Server-to-server access to <code className="font-mono">/v1</code>. Send the value
          as the <code className="font-mono">x-access-token</code> header.
        </p>
        <a className={`${GHOST} ml-auto`} href="/developers">
          API docs
        </a>
      </div>

      {result?.error ? (
        <p className="mb-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {result.error}
        </p>
      ) : null}

      {result?.minted ? (
        <div
          data-minted-key
          className="mb-4 rounded-lg border border-green-500 bg-green-50 p-3 dark:bg-green-950"
        >
          <p className="text-sm font-medium">
            “{result.minted.name}” created. Copy it now — this is the only time it is shown.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-white p-2 font-mono text-xs dark:bg-gray-900">
            {result.minted.plaintext}
          </pre>
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
            Scopes: {result.minted.scopes.join(", ")}. Only a SHA-256 hash is stored, so we
            cannot show it again.
          </p>
        </div>
      ) : null}

      {!data.event ? (
        <p className="rounded-lg border border-gray-200 p-6 text-sm dark:border-gray-800">
          No event yet. Create one in Settings first.
        </p>
      ) : (
        <>
          <form
            method="post"
            className="mb-6 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          >
            <input type="hidden" name="intent" value="mint" />
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">
                Key name
                <input
                  name="name"
                  required
                  className={FIELD}
                  placeholder="Accelevents sync"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Preset
                <select name="preset" className={FIELD} defaultValue="read_only">
                  <option value="read_only">Read only</option>
                  <option value="read_write">Read + write</option>
                  <option value="">Custom (tick below)</option>
                </select>
              </label>
              <button type="submit" className={BUTTON}>
                Create key
              </button>
            </div>
            <fieldset className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <legend className="text-xs text-gray-500">
                Custom scopes — they do not cascade, so a read scope never grants a write.
              </legend>
              {data.scopes.map((scope) => (
                <label key={scope} className="flex items-center gap-1 font-mono">
                  <input type="checkbox" name="scopes" value={scope} />
                  {scope}
                </label>
              ))}
            </fieldset>
          </form>

          {data.keys.length === 0 ? (
            <p
              data-empty-keys
              className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-gray-700"
            >
              No API keys yet. Create one above to call{" "}
              <code className="font-mono">/v1</code>.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.keys.map((key) => (
                <li
                  key={key.id}
                  data-key-row={key.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                >
                  <div className="min-w-48 flex-1">
                    <p className="text-sm font-medium">
                      {key.name}{" "}
                      <span className="font-mono text-xs text-gray-500">…{key.suffix}</span>
                      {key.revokedAt ? (
                        <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs dark:bg-gray-800">
                          revoked
                        </span>
                      ) : null}
                    </p>
                    <p className="font-mono text-xs text-gray-500">
                      {key.scopes.join(" · ") || "no scopes"}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      created {key.createdAt} · last used {key.lastUsedAt ?? "never"}
                    </p>
                  </div>
                  {key.revokedAt ? null : (
                    <form method="post">
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="keyId" value={key.id} />
                      <button type="submit" className={GHOST}>
                        Revoke
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function AdminApiKeys({ loaderData, actionData }: Route.ComponentProps) {
  return <ApiKeysScreen data={loaderData} result={actionData as ApiKeysAction | undefined} />;
}
