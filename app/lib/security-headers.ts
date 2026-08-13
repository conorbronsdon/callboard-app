/**
 * Security headers applied to every Worker response.
 *
 * The CSP is deliberately narrow: it adds framing/base/object protections
 * without declaring default-src, so existing React, style, font, and image
 * loading behavior is unchanged.
 */
export function withSecurityHeaders(response: Response, requestUrl: string): Response {
  const headers = new Headers(response.headers);
  const embeddable = isEmbeddablePath(new URL(requestUrl).pathname);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (embeddable) {
    headers.delete("x-frame-options");
    headers.set(
      "content-security-policy",
      "base-uri 'self'; object-src 'none'; frame-ancestors *",
    );
  } else {
    headers.set("x-frame-options", "DENY");
    headers.set(
      "content-security-policy",
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    );
  }

  if (new URL(requestUrl).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  } else {
    headers.delete("strict-transport-security");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Exact, case-sensitive `/embed` segment prefix — near-miss paths stay protected. */
export function isEmbeddablePath(pathname: string): boolean {
  const pathOnly = pathname.split(/[?#]/, 1)[0];
  return pathOnly === "/embed" || pathOnly.startsWith("/embed/");
}
