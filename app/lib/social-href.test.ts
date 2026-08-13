/**
 * Speaker profile links are operator-typed, and the renderer trusted them.
 *
 * `people.links` is a free-text JSON map — organizers type what a speaker sent
 * them, which is almost always `@handle`, sometimes `example.com/talks`, and
 * sometimes a real URL. Both admin surfaces piped the raw value straight into
 * `href={href}`, so `@conor` became a RELATIVE url: on
 * `/admin/speakers/abc` it resolved to `/admin/speakers/@conor` and the click
 * landed on a not-found page inside the workspace. Route soup, from a value the
 * app itself invited.
 *
 * `socialHref` is the one place that decision is made, so the abstract detail
 * and the speaker profile cannot drift.
 *
 * The two halves that matter:
 *   - must-fire — a handle or a bare domain becomes an absolute URL;
 *   - must-NOT-fire — a value that is already a URL is returned BYTE-IDENTICAL,
 *     and a value that is neither returns null so the caller renders text
 *     instead of a link. A normaliser that "helpfully" rewrites real URLs is a
 *     worse bug than the one being fixed, and one that returns a string for
 *     everything just moves the broken link.
 *
 * `null` is the interesting return: it is what keeps `javascript:` out of an
 * `href`, and it is the branch a permissive regex silently deletes.
 */
import { describe, expect, it } from "vitest";

import { socialHref } from "./social-href";

/* ─────────────────────────────────── must-fire: handles get a real home ── */

describe("an @handle becomes an absolute profile URL", () => {
  it("resolves a bare handle to x.com", () => {
    expect(socialHref("@conor")).toBe("https://x.com/conor");
  });

  it("accepts the underscores and digits handles actually contain", () => {
    expect(socialHref("@conor_b3")).toBe("https://x.com/conor_b3");
  });

  it("tolerates the whitespace a paste leaves behind", () => {
    expect(socialHref("  @conor  ")).toBe("https://x.com/conor");
  });
});

describe("a bare domain becomes https", () => {
  it("upgrades a bare host", () => {
    expect(socialHref("example.com")).toBe("https://example.com");
  });

  it("keeps the path, which is the whole point on linkedin", () => {
    expect(socialHref("linkedin.com/in/conorbronsdon")).toBe(
      "https://linkedin.com/in/conorbronsdon",
    );
  });

  it("upgrades a www host", () => {
    expect(socialHref("www.example.com/talks")).toBe("https://www.example.com/talks");
  });

  it("keeps a query string", () => {
    expect(socialHref("example.com/a?b=c")).toBe("https://example.com/a?b=c");
  });
});

/* ────────────────────── must-NOT-fire: a real URL is passed through as-is ── */

describe("a value that is already a URL is not rewritten", () => {
  it("returns an https URL unchanged", () => {
    const url = "https://x.com/conor";
    expect(socialHref(url)).toBe(url);
  });

  it("returns an https URL with path, query and fragment unchanged", () => {
    // Byte-identical: no trailing slash added, no query re-encoded, no
    // fragment dropped. This is the assertion that fails if someone routes
    // pass-through values through `new URL(...).toString()`.
    const url = "https://example.com/a/b?x=1&y=2#frag";
    expect(socialHref(url)).toBe(url);
  });

  it("leaves http alone rather than silently upgrading it", () => {
    // Rewriting the scheme would break an intranet speaker directory, and
    // "we changed your link" is not this function's job.
    const url = "http://example.com/profile";
    expect(socialHref(url)).toBe(url);
  });

  it("accepts an uppercase scheme without mangling the rest", () => {
    expect(socialHref("HTTPS://example.com/A")).toBe("HTTPS://example.com/A");
  });
});

/* ──────────────────────── must-NOT-fire: unknown shapes are not linked ── */

describe("anything that is not recognisably a link returns null", () => {
  it("refuses empty and whitespace", () => {
    expect(socialHref("")).toBeNull();
    expect(socialHref("   ")).toBeNull();
  });

  it("refuses prose", () => {
    // An organizer typing "ask me for it" must not produce an <a>.
    expect(socialHref("ask me for it")).toBeNull();
  });

  it("refuses a bare word with no dot", () => {
    expect(socialHref("conor")).toBeNull();
  });

  it("refuses a lone @", () => {
    expect(socialHref("@")).toBeNull();
  });

  it("refuses a handle with a space in it", () => {
    expect(socialHref("@conor bronsdon")).toBeNull();
  });

  it("refuses javascript:", () => {
    // The security-relevant branch. `javascript:alert(1)` in an href is a
    // stored XSS on a page only admins see — still a hole, and it costs one
    // allowlist to close.
    expect(socialHref("javascript:alert(1)")).toBeNull();
    expect(socialHref("JaVaScRiPt:alert(1)")).toBeNull();
  });

  it("refuses data: and other schemes we did not allow", () => {
    expect(socialHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(socialHref("ftp://example.com/pub")).toBeNull();
    expect(socialHref("mailto:someone@example.com")).toBeNull();
  });

  it("refuses a protocol-relative URL", () => {
    // `//evil.com` in an href silently inherits the page's scheme and leaves
    // the site. It is not a shape an organizer types on purpose.
    expect(socialHref("//evil.com")).toBeNull();
  });

  it("refuses a path, which is what the raw-value bug produced", () => {
    expect(socialHref("/admin/speakers/conor")).toBeNull();
  });

  it("survives non-string input from a JSON column", () => {
    // `people.links` is `json`, so the values are whatever was written. A
    // number or a null there must not throw inside a render.
    expect(socialHref(null as unknown as string)).toBeNull();
    expect(socialHref(undefined as unknown as string)).toBeNull();
    expect(socialHref(42 as unknown as string)).toBeNull();
    expect(socialHref({} as unknown as string)).toBeNull();
  });
});
