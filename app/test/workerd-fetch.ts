/**
 * Simulates workerd's `fetch` receiver check inside Vitest's Node environment.
 *
 * workerd's global `fetch` is a branded platform method: calling it with a
 * `this` that is neither `undefined` (a bare call) nor `globalThis` (an
 * explicitly bound or arrow-wrapped call) throws "Illegal invocation". Node's
 * `fetch` does not check its receiver at all, so a regression here is
 * invisible to every other test in the suite — see the three places this
 * already bit production: app/lib/integrations/airtable.server.ts:322-327
 * (fixed #190), app/lib/mail/resend.ts:106-119, and
 * app/lib/mcp/client.ts:155-164. All three now guard the default branch with
 * an arrow wrapper or `.bind(globalThis)`; this stub is what proves it.
 *
 * Empirically verified against real workerd (not guessed): a bare local-
 * variable call — `const f = fetch; f(url)` — does NOT throw. Only a
 * method-style call — `obj.f(url)` or `this.f(url)`, where `this` is some
 * object other than the global scope — throws. This stub reproduces exactly
 * that contract.
 */
import { vi } from "vitest";

export interface StrictFetchCall {
  input: string;
  init?: RequestInit;
  /** The `this` the call site actually supplied — `undefined` for a bare call. */
  receiver: unknown;
}

const ILLEGAL_INVOCATION =
  "Illegal invocation: function called with incorrect `this` reference.";

/**
 * Builds a receiver-checking fetch stub. Exported separately from
 * `withStrictFetch` for callers that need the call log to outlive a single
 * `vi.stubGlobal` block (e.g. asserting on it after a `finally`).
 */
export function strictFetchStub(
  respond: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
): { fn: typeof fetch; calls: StrictFetchCall[] } {
  const calls: StrictFetchCall[] = [];
  function fn(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError(ILLEGAL_INVOCATION);
    }
    calls.push({ input: String(input), init, receiver: this });
    return Promise.resolve(respond(input, init));
  }
  return { fn: fn as unknown as typeof fetch, calls };
}

/**
 * Runs `block` with `globalThis.fetch` replaced by the strict stub, restored
 * afterward even if `block` throws. `block` receives the call log so it can
 * assert on which URLs the code under test actually reached.
 */
export async function withStrictFetch<T>(
  block: (calls: StrictFetchCall[]) => Promise<T>,
  respond?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): Promise<T> {
  const { fn, calls } = strictFetchStub(respond);
  vi.stubGlobal("fetch", fn);
  try {
    return await block(calls);
  } finally {
    vi.unstubAllGlobals();
  }
}
