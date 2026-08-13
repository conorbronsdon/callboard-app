/**
 * THE sender identity — one constant for the `From` header AND the ICS
 * `ORGANIZER`, because they must move in lockstep.
 *
 * The Saturday ICS spike (DECISIONS.md #28) proved Gmail renders a native RSVP
 * card only while `ORGANIZER;CN=…:mailto:<x>` matches the address the message
 * was sent from. Two literals in two files is exactly how that invariant rots
 * the day `RESEND_FROM` changes to a verified domain — so both are derived HERE
 * from a single parsed value, and `sender.test.ts` asserts the lockstep property
 * over arbitrary inputs.
 *
 * Pure: no bindings. `sender.server.ts` supplies the env-backed instance.
 */

/**
 * Ships as the unverified Resend sandbox address (PLAN §9 item 1 — DNS
 * verification is the long pole). Changing the deployed `RESEND_FROM` var must
 * be the ONLY action needed to move to the verified domain: nothing downstream
 * hard-codes an address.
 */
export const DEFAULT_SENDER = "Callboard <onboarding@resend.dev>";

export interface Sender {
  /** RFC 5322 display form: `Name <email>` — the `From` header value. */
  display: string;
  name: string;
  email: string;
}

const ANGLE = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/;

/**
 * `Name <a@b.c>` or a bare `a@b.c`. Anything unparseable falls back to
 * DEFAULT_SENDER rather than throwing — a malformed env var must not take the
 * whole comms lane down, and the fallback is visible in the admin comm log.
 */
export function parseSender(raw?: string | null): Sender {
  const value = (raw ?? '').trim();
  if (!value) return fallback();

  const angled = ANGLE.exec(value);
  if (angled) {
    const name = angled[1].replace(/^"|"$/g, '').trim();
    const email = angled[2];
    if (isEmail(email)) {
      return { display: name ? `${name} <${email}>` : email, name: name || email, email };
    }
    return fallback();
  }

  if (isEmail(value)) return { display: value, name: value, email: value };
  return fallback();
}

function fallback(): Sender {
  const angled = ANGLE.exec(DEFAULT_SENDER)!;
  return {
    display: DEFAULT_SENDER,
    name: angled[1],
    email: angled[2],
  };
}

function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

/**
 * The ICS `ORGANIZER` property line value for a sender. The `mailto:` here and
 * the `From` header above come from the SAME `Sender`, which is the whole point
 * of this module.
 */
export function organizerMailto(sender: Sender): string {
  return `mailto:${sender.email}`;
}
