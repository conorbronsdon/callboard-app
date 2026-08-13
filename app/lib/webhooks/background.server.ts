/**
 * Register webhook work with the current Cloudflare request when one exists.
 *
 * Cloudflare added the importable `waitUntil` API in 2025. It is the same
 * lifetime extension as ExecutionContext.waitUntil, but can be called from a
 * deep route dependency without React Router load-context plumbing or Node's
 * AsyncLocalStorage. In direct Vitest action calls there is no Worker request
 * context, so the test adapter throws synchronously and this helper awaits the
 * already-started work instead. Either path observes the same never-rejecting
 * Promise; there is no floating fire-and-forget path.
 */
import { waitUntil } from "cloudflare:workers";

export async function waitUntilOrAwait(work: Promise<unknown>): Promise<void> {
  try {
    waitUntil(work);
  } catch {
    await work;
  }
}
