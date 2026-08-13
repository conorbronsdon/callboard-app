import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  signCookieValue,
  unsignCookieValue,
} from "./cookie";

const SECRET = "cookie-test-secret";

describe("signed session cookie value", () => {
  it("round-trips (must fire)", async () => {
    const signed = await signCookieValue("session-id-123", SECRET);
    expect(await unsignCookieValue(signed, SECRET)).toBe("session-id-123");
  });

  it("rejects a value signed with another secret (must NOT fire)", async () => {
    const signed = await signCookieValue("session-id-123", "other-secret");
    expect(await unsignCookieValue(signed, SECRET)).toBeNull();
  });

  it("rejects a swapped value with a valid-looking signature (must NOT fire)", async () => {
    const signed = await signCookieValue("session-id-123", SECRET);
    const signature = signed.slice(signed.lastIndexOf(".") + 1);
    expect(await unsignCookieValue(`attacker-session.${signature}`, SECRET)).toBeNull();
  });

  it("rejects unsigned, empty, and null input (must NOT fire)", async () => {
    expect(await unsignCookieValue("session-id-123", SECRET)).toBeNull();
    expect(await unsignCookieValue("", SECRET)).toBeNull();
    expect(await unsignCookieValue(null, SECRET)).toBeNull();
    expect(await unsignCookieValue(".sig", SECRET)).toBeNull();
    expect(await unsignCookieValue("value.", SECRET)).toBeNull();
  });
});

describe("readCookie", () => {
  it("finds the named cookie among several", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc.def; other=1`;
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe("abc.def");
  });

  it("does not match on a name prefix", () => {
    expect(readCookie(`${SESSION_COOKIE_NAME}_other=nope`, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("returns null for a missing cookie or absent header", () => {
    expect(readCookie("theme=dark", SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
  });

  it("url-decodes the value", () => {
    expect(readCookie(`${SESSION_COOKIE_NAME}=a%2Bb`, SESSION_COOKIE_NAME)).toBe("a+b");
  });

  /*
   * A malformed percent-escape makes `decodeURIComponent` throw a URIError, and
   * every caller here reads cookies on the request path: `cb_session` on every
   * authenticated route, `cb_admin_event` on every /admin page. An unguarded
   * decode turns one tampered cookie into a 500 on every page for the cookie's
   * 30-day life, with no way out that does not involve devtools — the exact
   * lockout the module header says must not happen. Treat it as absent.
   */
  it("treats a malformed percent-escape as an absent cookie (must fire)", () => {
    for (const value of ["%", "%zz", "%E0%A4%A", "100%discount", "%%"]) {
      expect(
        readCookie(`${SESSION_COOKIE_NAME}=${value}`, SESSION_COOKIE_NAME),
        `cookie value ${value} must not throw`,
      ).toBeNull();
    }
  });

  it("must still fire: well-formed values are unaffected by that guard", () => {
    // The complement. A `readCookie` that returned null unconditionally would
    // pass the case above and lock everyone out for real.
    expect(readCookie(`${SESSION_COOKIE_NAME}=abc.def`, SESSION_COOKIE_NAME)).toBe("abc.def");
    expect(readCookie(`${SESSION_COOKIE_NAME}=a%2Bb`, SESSION_COOKIE_NAME)).toBe("a+b");
    expect(readCookie(`${SESSION_COOKIE_NAME}=junk`, SESSION_COOKIE_NAME)).toBe("junk");
    // A malformed value on a DIFFERENT cookie was never the problem (the name
    // check runs before the decode) and must stay a non-problem.
    expect(readCookie(`other=%; ${SESSION_COOKIE_NAME}=abc.def`, SESSION_COOKIE_NAME)).toBe(
      "abc.def",
    );
  });
});

describe("cookie serialization", () => {
  it("sets HttpOnly and SameSite=Lax, and Secure only when asked", () => {
    const insecure = serializeSessionCookie("v.s", { secure: false });
    expect(insecure).toContain("HttpOnly");
    // Lax, never Strict: the login flow is an email-initiated cross-site navigation.
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).not.toContain("SameSite=Strict");
    expect(insecure).not.toContain("Secure");

    expect(serializeSessionCookie("v.s", { secure: true })).toContain("Secure");
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie({ secure: true })).toContain("Max-Age=0");
  });

  it("round-trips through readCookie", async () => {
    const signed = await signCookieValue("sid", SECRET);
    const header = serializeSessionCookie(signed, { secure: true });
    const value = header.slice(header.indexOf("=") + 1, header.indexOf(";"));
    expect(await unsignCookieValue(decodeURIComponent(value), SECRET)).toBe("sid");
  });
});
