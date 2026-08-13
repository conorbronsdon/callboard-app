import { describe, expect, it } from "vitest";

import { EMBED_WIDGETS } from "./embeds";
import { isEmbeddablePath, withSecurityHeaders } from "./security-headers";

/**
 * Written out rather than generated, so each one is a real request through the
 * real header code. The catalogue check below is what keeps the list honest
 * when a widget is added — `agenda` and `gallery` shipped without it and the
 * enumeration silently stopped enumerating.
 */
const EMBED_ROUTES = [
  "/embed/frontier-ai-summit-2026/schedule",
  "/embed/frontier-ai-summit-2026/speakers",
  "/embed/frontier-ai-summit-2026/agenda",
  "/embed/frontier-ai-summit-2026/gallery",
];

describe("withSecurityHeaders", () => {
  it("adds browser hardening headers to HTTPS responses", () => {
    const response = withSecurityHeaders(
      new Response("ok", { headers: { "x-existing": "kept" } }),
      "https://callboard.example.test/admin",
    );

    expect(response.headers.get("x-existing")).toBe("kept");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("does not advertise HSTS over local HTTP", () => {
    const response = withSecurityHeaders(
      new Response("ok", { headers: { "strict-transport-security": "stale" } }),
      "http://localhost:5173/",
    );

    expect(response.headers.has("strict-transport-security")).toBe(false);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preserves status and body", async () => {
    const response = withSecurityHeaders(
      new Response("missing", { status: 404, statusText: "Not Found" }),
      "https://callboard.example.test/nope",
    );

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
    expect(await response.text()).toBe("missing");
  });

  /*
   * Every embed route, not just the first one. A per-route list rather than a
   * single sample: the exception is keyed off the `/embed` segment, so a new
   * widget inherits it silently — and a widget that did NOT inherit it would
   * be an invisible failure, a blank iframe on somebody else's site.
   */
  it("MUST FIRE: the enumerated list covers every widget in the catalogue", () => {
    expect(EMBED_ROUTES.map((route) => route.split("/").at(-1)).sort()).toEqual(
      EMBED_WIDGETS.map((widget) => widget.path).sort(),
    );
  });

  it.each(EMBED_ROUTES)("MUST FIRE: %s permits framing and omits X-Frame-Options", (pathname) => {
    const response = withSecurityHeaders(
      new Response("embed"),
      `https://callboard.example.test${pathname}`,
    );

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect(response.headers.get("content-security-policy")).not.toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.has("x-frame-options")).toBe(false);
  });

  it("MUST STILL FIRE: the public twin of every embed route stays frame-denied", () => {
    for (const pathname of EMBED_ROUTES.map((route) => route.replace("/embed/", "/e/"))) {
      const response = withSecurityHeaders(
        new Response("public"),
        `https://callboard.example.test${pathname}`,
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  it("MUST FIRE: strips inherited X-Frame-Options on embed paths", () => {
    const response = withSecurityHeaders(
      new Response("embed", { headers: { "x-frame-options": "SAMEORIGIN" } }),
      "https://callboard.example.test/embed/frontier-ai-summit-2026/schedule",
    );

    expect(response.headers.has("x-frame-options")).toBe(false);
  });

  it.each([
    "/admin",
    "/admin/embeds",
    "/portal",
    "/",
    "/login",
    "/e/x/schedule",
    "/embedded",
    "/embeds",
    "/embed-demo",
    "/EMBED/x/schedule",
    "/portal/embed/x",
  ])("MUST STILL FIRE: %s remains frame-denied", (pathname) => {
    const response = withSecurityHeaders(
      new Response("protected"),
      `https://callboard.example.test${pathname}`,
    );

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe("isEmbeddablePath", () => {
  it.each([
    "/embed/x/schedule",
    "/embed/x/schedule?theme=dark",
    "/embed/x",
    "/embed",
    "/embed/",
  ])("matches %s", (pathname) => {
    expect(isEmbeddablePath(pathname)).toBe(true);
  });

  it.each([
    "/embedded",
    "/embeds",
    "/embed-demo",
    "/admin/embeds",
    "/EMBED/x/schedule",
    "/e/x/schedule",
    "/portal/embed/x",
  ])("does not match %s", (pathname) => {
    expect(isEmbeddablePath(pathname)).toBe(false);
  });
});
