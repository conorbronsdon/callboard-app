/**
 * Sanitizer tests — DELIBERATELY two-sided (AGENTS.md rule 2).
 *
 * `must-fire` proves the dangerous input is neutralised. `must-not-fire` proves
 * the sanitizer is not simply deleting everything: a YouTube embed, a Google
 * Maps embed, ordinary formatting, tables, and prose that merely *mentions*
 * "script" or "onerror" all have to survive byte-for-byte where it matters.
 *
 * Every must-fire case asserts on VALUES (the literal payload is absent from
 * the output string), not on shape — `expect(html).toBeTruthy()` would pass for
 * every mutation of this file.
 */
import { describe, expect, it } from "vitest";

import {
  checkIframeSrc,
  checkUrl,
  decodeEntities,
  normalizeUrl,
  sanitizeHtml,
  sanitizeHtmlToString,
  sanitizeStyle,
} from "./sanitize-html";

const clean = (input: string) => sanitizeHtmlToString(input);

/* ------------------------------------------------------------- must fire */

describe("sanitizeHtml — must fire", () => {
  it("strips <script> and its body, leaving no payload behind", () => {
    const html = clean('<p>hi</p><script>alert(1)</script><p>bye</p>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toBe("<p>hi</p><p>bye</p>");
  });

  it("does not trust a self-closing <script/>", () => {
    const html = clean('<script src="https://evil.example/x.js"/>alert(9)</script><p>ok</p>');
    expect(html).not.toContain("alert(9)");
    expect(html).not.toContain("evil.example");
    expect(html).toBe("<p>ok</p>");
  });

  it("strips onerror= from an <img>", () => {
    const html = clean('<img src="x.png" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain('src="x.png"');
  });

  it("strips every on* handler, not just the famous ones", () => {
    for (const handler of ["onclick", "onload", "onmouseover", "onfocus", "onanimationstart"]) {
      const html = clean(`<div ${handler}="steal()">text</div>`);
      expect(html, handler).not.toContain(handler);
      expect(html, handler).not.toContain("steal()");
      expect(html, handler).toContain("text");
    }
  });

  it("drops a javascript: href", () => {
    const html = clean('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("click");
  });

  it("drops a javascript: href regardless of case", () => {
    const html = clean('<a href="jAvAsCrIpT:alert(1)">click</a>');
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("drops an entity-encoded javascript: href", () => {
    const html = clean('<a href="java&#115;cript&colon;alert(1)">click</a>');
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).not.toContain("alert(1)");
  });

  it("drops a javascript: href split by control characters", () => {
    const payload = `java${String.fromCharCode(9)}script${String.fromCharCode(10)}:alert(1)`;
    const html = clean(`<a href="${payload}">click</a>`);
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("drops data: and vbscript: URLs", () => {
    expect(clean('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).not.toContain("data:");
    expect(clean('<a href="vbscript:msgbox(1)">x</a>')).not.toContain("vbscript:");
  });

  it("drops an iframe whose host is not on the embed allowlist", () => {
    const html = clean('<iframe src="https://evil.example/frame"></iframe>');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  it("drops <style> including its rules", () => {
    const html = clean("<style>body{display:none}</style><p>visible</p>");
    expect(html).not.toContain("display:none");
    expect(html).toBe("<p>visible</p>");
  });

  it("drops <svg onload=…> whole", () => {
    const html = clean('<svg onload="alert(1)"><circle r="1"/></svg><p>after</p>');
    expect(html).not.toContain("svg");
    expect(html).not.toContain("onload");
    expect(html).toBe("<p>after</p>");
  });

  it("drops <object>, <embed>, <base>, <meta>, <link> and <form>", () => {
    expect(clean('<object data="evil.swf"></object>')).not.toContain("evil.swf");
    expect(clean('<embed src="evil.swf">')).not.toContain("evil.swf");
    expect(clean('<base href="https://evil.example/">')).not.toContain("evil.example");
    expect(clean('<meta http-equiv="refresh" content="0;url=https://evil.example">')).not.toContain(
      "evil.example",
    );
    expect(clean('<link rel="stylesheet" href="https://evil.example/x.css">')).not.toContain(
      "evil.example",
    );
    const form = clean('<form action="https://evil.example"><input name="password"></form>');
    expect(form).not.toContain("evil.example");
    expect(form).not.toContain("password");
  });

  it("strips srcdoc and formaction", () => {
    expect(clean('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).not.toContain("srcdoc");
    expect(clean('<a formaction="javascript:alert(1)">x</a>')).not.toContain("formaction");
  });

  it("neutralises an unsafe inline style", () => {
    const html = clean('<div style="background:url(javascript:alert(1))">x</div>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("style=");
  });

  it("drops HTML comments (conditional comments are a script vector)", () => {
    expect(clean("<!--[if IE]><script>alert(1)</script><![endif]-->ok")).toBe("ok");
  });

  it("balances an unclosed tag so a paste cannot swallow the page", () => {
    const html = clean("<div><p>dangling");
    expect(html).toBe("<div><p>dangling</p></div>");
  });

  it("ignores a stray closing tag", () => {
    expect(clean("</div><p>x</p>")).toBe("<p>x</p>");
  });

  it("escapes a stray < so it cannot start a tag downstream", () => {
    expect(clean("5 < 6 and 7 > 6")).toBe("5 &lt; 6 and 7 &gt; 6");
  });

  it("reports what it removed", () => {
    const result = sanitizeHtml('<script>x</script><img src=a onerror=b><iframe src="https://evil.example"></iframe>');
    expect(result.removed).toContain("<script> element");
    expect(result.removed).toContain("onerror= event handler");
    expect(result.removed.some((entry) => entry.includes("evil.example"))).toBe(true);
  });
});

/* --------------------------------------------------------- must NOT fire */

describe("sanitizeHtml — must NOT fire", () => {
  it("preserves a YouTube iframe embed with its src intact", () => {
    const embed =
      '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" ' +
      'title="YouTube video player" frameborder="0" ' +
      'allow="accelerometer; autoplay; clipboard-write; encrypted-media" allowfullscreen></iframe>';
    const html = clean(embed);
    expect(html).toContain("<iframe");
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain('width="560"');
    expect(html).toContain('height="315"');
    expect(html).toContain("allowfullscreen");
    expect(html).toContain("</iframe>");
  });

  it("preserves youtube-nocookie and youtu.be embeds", () => {
    expect(clean('<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>')).toContain(
      "youtube-nocookie.com/embed/abc",
    );
    expect(clean('<iframe src="https://youtu.be/abc"></iframe>')).toContain("youtu.be/abc");
  });

  it("preserves a Google Maps iframe embed, style and all", () => {
    const embed =
      '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12" width="600" height="450" ' +
      'style="border:0;" allowfullscreen="" loading="lazy" ' +
      'referrerpolicy="no-referrer-when-downgrade"></iframe>';
    const html = clean(embed);
    expect(html).toContain('src="https://www.google.com/maps/embed?pb=!1m18!1m12"');
    expect(html).toContain('style="border:0;"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
  });

  it("still refuses google.com outside /maps", () => {
    expect(clean('<iframe src="https://www.google.com/search?q=x"></iframe>')).not.toContain(
      "<iframe",
    );
  });

  it("preserves ordinary formatting", () => {
    const source =
      "<h2>Getting here</h2><p><strong>Bold</strong>, <em>italic</em>, <u>underline</u> and " +
      "<code>inline code</code>.</p><blockquote>Quoted.</blockquote><hr />";
    expect(clean(source)).toBe(source.replace("<hr />", "<hr />"));
  });

  it("preserves lists and tables", () => {
    const list = "<ul><li>one</li><li>two</li></ul><ol start=\"3\"><li>three</li></ol>";
    expect(clean(list)).toBe('<ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li></ol>');

    const table =
      '<table><thead><tr><th scope="col">Room</th></tr></thead>' +
      '<tbody><tr><td colspan="2">Main Stage</td></tr></tbody></table>';
    expect(clean(table)).toBe(table);
  });

  it("preserves safe links and adds noopener to target=_blank", () => {
    const html = clean('<a href="https://example.com/handbook" target="_blank">Handbook</a>');
    expect(html).toContain('href="https://example.com/handbook"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
  });

  it("preserves relative, anchor, mailto and tel links", () => {
    expect(clean('<a href="/portal/tasks">Tasks</a>')).toContain('href="/portal/tasks"');
    expect(clean('<a href="#av">AV</a>')).toContain('href="#av"');
    expect(clean('<a href="mailto:speakers@example.com">Email</a>')).toContain(
      'href="mailto:speakers@example.com"',
    );
    expect(clean('<a href="tel:+15551234567">Call</a>')).toContain('href="tel:+15551234567"');
  });

  it("preserves images", () => {
    const html = clean('<img src="https://cdn.example.com/stage.png" alt="Main stage" width="640">');
    expect(html).toContain('src="https://cdn.example.com/stage.png"');
    expect(html).toContain('alt="Main stage"');
    expect(html).toContain('width="640"');
  });

  it("does NOT mangle prose that merely mentions script, onerror or javascript", () => {
    const source =
      "<p>Do not paste a script tag. An onerror handler or a javascript: URL will be removed.</p>";
    const html = clean(source);
    expect(html).toBe(source);
    expect(html).toContain("script tag");
    expect(html).toContain("onerror handler");
    expect(html).toContain("javascript: URL");
  });

  it("strips untrusted CSS classes but preserves a benign id", () => {
    const html = clean('<div class="fixed inset-0 z-50" id="speaker-notes">Notes</div>');
    expect(html).not.toContain("class=");
    expect(html).toContain('id="speaker-notes"');
  });

  it("keeps aria-* and data-* attributes", () => {
    const html = clean('<div aria-label="Schedule" data-day="2">x</div>');
    expect(html).toContain('aria-label="Schedule"');
    expect(html).toContain('data-day="2"');
  });

  it("keeps a benign inline style", () => {
    expect(clean('<p style="text-align:center">Centred</p>')).toContain(
      'style="text-align:center;"',
    );
  });

  it("returns an empty removal report when nothing was removed", () => {
    const result = sanitizeHtml("<p>All <strong>fine</strong>.</p>");
    expect(result.removed).toEqual([]);
    expect(result.html).toBe("<p>All <strong>fine</strong>.</p>");
  });

  it("is a no-op on empty input", () => {
    expect(sanitizeHtml("")).toEqual({ html: "", removed: [] });
  });
});

/* ----------------------------------------- strict CSS / iframe must fire */

describe("strict CSS and iframe policy — must fire", () => {
  it("rejects CSS that can overlay, hide, animate or load external content", () => {
    for (const style of [
      "position:fixed;inset:0;z-index:9999",
      "display:none",
      "opacity:0",
      "animation:spin 1s infinite",
      "background:url(https://tracker.example/pixel)",
      "--payload:url(https://tracker.example/pixel)",
    ]) {
      const result = sanitizeHtml(`<div style="${style}">Visible content</div>`);
      expect(result.html, style).not.toContain("style=");
      expect(result.html, style).not.toContain("tracker.example");
      expect(result.removed, style).toContain("unsafe inline style");
    }
  });

  it("requires HTTPS and rejects iframe URLs containing credentials", () => {
    expect(clean('<iframe src="http://www.youtube.com/embed/abc"></iframe>')).not.toContain(
      "<iframe",
    );
    expect(
      clean('<iframe src="https://user:pass@www.youtube.com/embed/abc"></iframe>'),
    ).not.toContain("<iframe");
  });

  it("overrides permissive iframe controls and drops unsafe permissions", () => {
    const result = sanitizeHtml(
      '<iframe src="https://www.youtube.com/embed/abc" width="99999" height="315" ' +
        'class="fixed inset-0" name="trusted-window" sandbox="allow-top-navigation allow-forms" ' +
        'referrerpolicy="unsafe-url" loading="eager" frameborder="1" ' +
        'allow="camera *; microphone *; autoplay; fullscreen"></iframe>',
    );

    expect(result.html).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
    expect(result.html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(result.html).toContain('loading="lazy"');
    expect(result.html).toContain('allow="autoplay; fullscreen"');
    expect(result.html).toContain('height="315"');
    expect(result.html).not.toContain("allow-top-navigation");
    expect(result.html).not.toContain("allow-forms");
    expect(result.html).not.toContain("unsafe-url");
    expect(result.html).not.toContain('loading="eager"');
    expect(result.html).not.toContain("camera");
    expect(result.html).not.toContain("microphone");
    expect(result.html).not.toContain("99999");
    expect(result.html).not.toContain("class=");
    expect(result.html).not.toContain("name=");
    expect(result.removed).toContain("unsafe iframe permission");
    expect(result.removed).toContain("unsafe iframe width");
  });

  it("rejects duplicate valueless iframe control attributes", () => {
    const html = clean(
      '<iframe src="https://www.youtube.com/embed/abc" sandbox loading referrerpolicy></iframe>',
    );
    expect(html.match(/sandbox=/g)).toHaveLength(1);
    expect(html.match(/loading=/g)).toHaveLength(1);
    expect(html.match(/referrerpolicy=/g)).toHaveLength(1);
  });
});

/* ------------------------------------- strict CSS / iframe must not fire */

describe("strict CSS and iframe policy — must not fire", () => {
  it("keeps the presentational CSS used by supported embeds", () => {
    expect(sanitizeStyle("border:0;text-align:center")).toBe(
      "border:0;text-align:center;",
    );
    const html = clean(
      '<iframe src="https://www.google.com/maps/embed?pb=map" style="border:0"></iframe>',
    );
    expect(html).toContain('style="border:0;"');
  });

  it("keeps a functional YouTube embed while adding required containment", () => {
    const html = clean(
      '<iframe src="https://www.youtube-nocookie.com/embed/abc" width="560" height="315" ' +
        'allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>',
    );
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc"');
    expect(html).toContain('width="560"');
    expect(html).toContain('height="315"');
    expect(html).toContain(
      'allow="accelerometer; autoplay; encrypted-media; picture-in-picture"',
    );
    expect(html).toContain("allowfullscreen");
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
    expect(html).toContain('loading="lazy"');
  });
});

/* -------------------------------------------------------- helper units */

describe("URL and entity helpers", () => {
  it("decodes decimal, hex and named entities, with or without the semicolon", () => {
    expect(decodeEntities("&#106;")).toBe("j");
    expect(decodeEntities("&#x6A;")).toBe("j");
    expect(decodeEntities("&#106")).toBe("j");
    expect(decodeEntities("&colon;")).toBe(":");
    expect(decodeEntities("&amp;")).toBe("&");
  });

  it("leaves an unknown entity alone rather than corrupting text", () => {
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
  });

  it("normalizeUrl removes control characters and trims", () => {
    expect(normalizeUrl(`  java${String.fromCharCode(9)}script:x  `)).toBe("javascript:x");
  });

  it("checkUrl accepts safe schemes and relative URLs, rejects the rest", () => {
    expect(checkUrl("https://example.com").ok).toBe(true);
    expect(checkUrl("http://example.com").ok).toBe(true);
    expect(checkUrl("mailto:a@b.c").ok).toBe(true);
    expect(checkUrl("tel:+1555").ok).toBe(true);
    expect(checkUrl("/relative/path").ok).toBe(true);
    expect(checkUrl("#anchor").ok).toBe(true);
    expect(checkUrl("javascript:alert(1)").ok).toBe(false);
    expect(checkUrl("data:text/html,x").ok).toBe(false);
    expect(checkUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("checkIframeSrc gates on host, not just scheme", () => {
    const hosts = new Set(["www.youtube.com"]);
    expect(checkIframeSrc("https://www.youtube.com/embed/x", hosts).ok).toBe(true);
    expect(checkIframeSrc("https://evil.example/embed/x", hosts).ok).toBe(false);
    expect(checkIframeSrc("https://www.youtube.com.evil.example/x", hosts).ok).toBe(false);
  });

  it("sanitizeStyle keeps inert declarations and rejects the rest", () => {
    expect(sanitizeStyle("border:0;")).toBe("border:0;");
    expect(sanitizeStyle("background:url(https://cdn.example.com/a.png)")).toBeNull();
    expect(sanitizeStyle("width:expression(alert(1))")).toBeNull();
    expect(sanitizeStyle("background:url(javascript:alert(1))")).toBeNull();
    expect(sanitizeStyle("@import url(https://evil.example/x.css)")).toBeNull();
  });
});
