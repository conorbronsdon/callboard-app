/**
 * The env-backed sender. Everything that needs a `From` header or an ICS
 * ORGANIZER goes through here, so a `RESEND_FROM` change moves both at once.
 */
import { appEnv } from "~/lib/env.server";

import { parseSender, type Sender } from "./sender";

export function currentSender(): Sender {
  return parseSender(appEnv().RESEND_FROM);
}

export { DEFAULT_SENDER, organizerMailto, parseSender } from "./sender";
export type { Sender } from "./sender";
