import { describe, expect, it } from "vitest";

import { markdownExcerpt, markdownToHtml, renderMarkdown } from "./markdown";

describe("markdownToHtml", () => {
  it("renders headings, emphasis, code and links", () => {
    expect(markdownToHtml("# Title")).toBe("<h1>Title</h1>");
    expect(markdownToHtml("**bold** and *italic*")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
    expect(markdownToHtml("use `npm run seed`")).toBe("<p>use <code>npm run seed</code></p>");
    expect(markdownToHtml("[docs](https://example.com)")).toBe(
      '<p><a href="https://example.com">docs</a></p>',
    );
  });

  it("renders lists, quotes, rules and fenced code", () => {
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(markdownToHtml("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(markdownToHtml("---")).toBe("<hr />");
    expect(markdownToHtml("```\nx = 1\n```")).toBe("<pre><code>x = 1\n</code></pre>");
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    expect(markdownToHtml("one\ntwo\n\nthree")).toBe("<p>one two</p><p>three</p>");
  });

  /* --- must fire: markdown source cannot smuggle HTML through --- */

  it("escapes raw HTML in the source instead of emitting it", () => {
    const html = markdownToHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders an img onerror payload as inert text, not an element", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The payload survives as VISIBLE TEXT — that is the correct outcome. What
    // must not survive is a live element, so assert on the tag, not the word.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("onerror"); // as escaped prose
  });

  it("strips a javascript: link written with markdown syntax", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  /* --- must NOT fire --- */

  it("leaves ordinary prose untouched", () => {
    expect(renderMarkdown("Just a sentence.")).toBe("<p>Just a sentence.</p>");
  });

  it("keeps a safe markdown link through the sanitizer", () => {
    expect(renderMarkdown("[handbook](https://example.com/h)")).toBe(
      '<p><a href="https://example.com/h">handbook</a></p>',
    );
  });

  it("keeps an underscore inside a word from becoming emphasis", () => {
    expect(markdownToHtml("run npm_run_seed now")).toBe("<p>run npm_run_seed now</p>");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToHtml("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
  });
});

describe("markdownExcerpt", () => {
  it("strips syntax and truncates", () => {
    expect(markdownExcerpt("# Title\n\nSome **bold** text.")).toBe("Title Some bold text.");
    expect(markdownExcerpt("abcdefghij", 5)).toBe("abcd…");
  });

  it("does not truncate what already fits", () => {
    expect(markdownExcerpt("short", 40)).toBe("short");
  });

  it("handles null", () => {
    expect(markdownExcerpt(null)).toBe("");
  });
});
