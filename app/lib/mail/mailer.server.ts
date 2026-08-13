/**
 * Mailer selection: `MAIL_DRIVER` when it pins one, else Resend when a key
 * exists, else console.
 *
 * A fresh clone with no `.dev.vars` still runs every email path end to end —
 * the message (and any magic link in it) is printed to the Worker console. That
 * property is load-bearing for the judged demo and for local development, so
 * the console mailer stays the default rather than becoming a test-only stub.
 *
 * MAIL_DRIVER exists because "no key" stopped being a safe test default the
 * moment a real key landed in a developer's `.dev.vars`: the Playwright web
 * server boots the same `npm run dev` and inherits that file, so scheduling a
 * PUBLISHED session in an e2e run posted live mail to api.resend.com (six
 * comm_log rows carrying `resend: HTTP 403` / `HTTP 422` proved it). The switch
 * is checked FIRST and by explicit value so the safe path cannot depend on the
 * absence of configuration — `playwright.config.ts` sets it, `vite.config.ts`
 * forwards it into the Worker's vars, and a deployed Worker that sets nothing
 * behaves exactly as before.
 *
 * `From` comes from app/lib/comms/sender, which is the SAME module the ICS
 * ORGANIZER is derived from (DECISIONS.md #28 — they must move in lockstep).
 */
import { currentSender } from "~/lib/comms/sender.server";
import { appEnv } from "~/lib/env.server";

import { ConsoleMailer, type Mailer } from "./mailer";
import { ResendMailer } from "./resend";

/** Say it once per isolate, not once per email. */
let announcedOverride = false;

export function getMailer(): Mailer {
  const env = appEnv();
  const key = env.RESEND_API_KEY;

  if (env.MAIL_DRIVER === "console") {
    if (key && !announcedOverride) {
      announcedOverride = true;
      console.warn(
        "[callboard] MAIL_DRIVER=console — using ConsoleMailer and ignoring RESEND_API_KEY. " +
          "No mail will reach a real provider.",
      );
    }
    return new ConsoleMailer();
  }

  if (key) {
    return new ResendMailer({ apiKey: key, from: currentSender().display });
  }
  return new ConsoleMailer();
}

export { ConsoleMailer, MemoryMailer } from "./mailer";
export { ResendMailer } from "./resend";
export type { Mailer, MailMessage, MailResult } from "./mailer";
