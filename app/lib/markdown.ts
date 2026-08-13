/**
 * Markdown-lite → HTML for speaker bios and resource pages.
 *
 * Hand-rolled rather than a dependency (AGENTS.md rule 7): the portal needs
 * headings, emphasis, links, lists, quotes and code — perhaps 80 lines of it —
 * and a markdown library is ~50 KB in a Worker bundle that is scored on speed.
 *
 * SECURITY: the source is escaped BEFORE any markup is generated, so raw HTML
 * in a bio is inert text, and the result is still passed through
 * `sanitizeHtml` by `renderMarkdown`. Two independent barriers, because the
 * bio field is user-controlled and rendered with `dangerouslySetInnerHTML`.
 */
import { sanitizeHtml } from "./sanitize-html";

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline spans. Runs on ALREADY-ESCAPED text, so it can only emit known tags. */
function inline(text: string): string {
  return (
    text
      // `code` first — its contents must not be re-processed for emphasis.
      .replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => `<img src="${src}" alt="${alt}" />`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => `<a href="${href}">${label}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>")
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
  );
}

/**
 * Render markdown to HTML. Block-level: headings, fenced code, blockquotes,
 * unordered/ordered lists, horizontal rules, paragraphs. Anything else becomes
 * paragraph text.
 */
export function markdownToHtml(source: string): string {
  if (!source?.trim()) return "";

  /*
   * Block markers are matched on the RAW line and only the captured content is
   * escaped. Escaping the whole document first (the obvious ordering) turns
   * every `>` into `&gt;` before the blockquote rule ever sees it — caught by
   * the "renders lists, quotes, rules and fenced code" test.
   */
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let listTag: "ul" | "ol" | null = null;
  let inQuote = false;
  let inCode = false;
  let paragraph: string[] = [];

  /** Escape, then apply inline spans — never the other way round. */
  const span = (text: string) => inline(escapeHtml(text));

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${span(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listTag) return;
    out.push(`</${listTag}>`);
    listTag = null;
  };
  const closeQuote = () => {
    if (!inQuote) return;
    out.push("</blockquote>");
    inQuote = false;
  };
  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        closeBlocks();
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${span(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      closeBlocks();
      out.push("<hr />");
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${span(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const wanted = bullet ? "ul" : "ol";
      if (listTag !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listTag = wanted;
      }
      out.push(`<li>${span((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    closeList();

    paragraph.push(line.trim());
  }

  if (inCode) out.push("</code></pre>");
  closeBlocks();

  return out.join("");
}

/**
 * The only renderer any route should call: markdown → HTML → sanitizer.
 * Belt and braces — `markdownToHtml` escapes first, and the sanitizer is the
 * second barrier in case a future inline rule is written carelessly.
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return "";
  return sanitizeHtml(markdownToHtml(source)).html;
}

/** Plain-text preview for list rows and meta descriptions. */
export function markdownExcerpt(source: string | null | undefined, maxChars = 160): string {
  if (!source) return "";
  const text = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_~`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
