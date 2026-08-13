/**
 * Signed-in requests for route-level tests.
 *
 * Uses the real `createLoginSession`, so a test that passes here proves the
 * route's own `requireAdmin` guard accepted a genuine signed cookie rather than
 * a stubbed-out auth module.
 */
import { createLoginSession } from "~/lib/auth/auth.server";

async function cookieFor(url: string, personId: string): Promise<string> {
  const setCookie = await createLoginSession(new Request(url), personId);
  return setCookie.split(";")[0];
}

export async function signedInGet(url: string, personId: string): Promise<Request> {
  return new Request(url, { headers: { cookie: await cookieFor(url, personId) } });
}

export async function signedInPost(
  url: string,
  personId: string,
  fields: Record<string, string>,
): Promise<Request> {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: await cookieFor(url, personId),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
}
