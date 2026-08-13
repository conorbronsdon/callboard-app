/**
 * `POST /v1/event/{eventId}/sessions/search`.
 *
 * Same handler as the bare collection POST — re-exported rather than
 * duplicated, so the two paths can never diverge. Two route entries, one
 * implementation.
 */
export { action, loader } from "./v1.sessions";
