/**
 * Server-side HTML sanitizer for portal resource pages (DECISIONS.md #12).
 *
 * Sessionboard ships a banner saying it does not validate custom code and hands
 * the string to the browser. We validate it: raw-HTML embed blocks go through
 * this function on the way OUT of the database, every time, and the caller gets
 * a list of what was stripped so the admin can be told.
 *
 * Design constraints:
 * - **Pure.** No DOM, no `window`, no bindings — Workers has no `DOMParser`, and
 *   a pure function is the only kind you can unit-test both directions.
 * - **Allowlist, never blocklist.** Unknown tags are dropped, not tolerated.
 *   A blocklist is a list of the attacks you already thought of.
 * - **Balanced output.** Tags are emitted through an open-element stack, so an
 *   unclosed `<div>` in a pasted embed cannot swallow the rest of the page.
 * - **Decode before you judge.** `java&#115;cript:` and `java\tscript:` are the
 *   two classic scheme-filter bypasses; URLs are entity-decoded and stripped of
 *   control characters BEFORE the scheme check, and the cleaned value is what
 *   gets emitted.
 *
 * Tests live in sanitize-html.test.ts and run in both directions: must-fire
 * (script/handler/javascript: is gone) AND must-not-fire (a YouTube iframe, a
 * Maps iframe, and ordinary formatting all survive intact). A sanitizer with
 * only must-fire tests is indistinguishable from `() => ""`.
 */

/* ------------------------------------------------------------- allowlists */

/** Elements that survive. Everything else is dropped or unwrapped. */
const ALLOWED_TAGS = new Set([
  // flow + text
  "p", "br", "hr", "span", "div", "section", "article", "header", "footer",
  "main", "aside", "nav", "address", "blockquote", "q", "cite", "abbr", "time",
  "h1", "h2", "h3", "h4", "h5", "h6",
  // inline formatting
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub",
  "sup", "code", "pre", "kbd", "samp", "var", "wbr",
  // lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // tables
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  // media + embeds
  "a", "img", "figure", "figcaption", "picture", "source", "video", "audio",
  "track", "iframe",
  // disclosure
  "details", "summary",
]);

/**
 * Dropped WITH their contents. `<script>alert(1)</script>` must not leave
 * `alert(1)` behind as text, and `<style>` content is a stylesheet, not prose.
 * `form`/`select`/`button` go too: a portal page that renders an attacker's
 * form is a credential-phishing surface inside our own origin.
 */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "noscript", "noembed", "noframes", "template", "xmp",
  "plaintext", "title", "textarea", "svg", "math", "object", "applet",
  "form", "select", "option", "optgroup", "button", "canvas", "dialog",
  "frameset",
]);

/** Void elements that are dropped outright — they have no contents to keep. */
const DROP_VOID = new Set([
  "base", "link", "meta", "input", "param", "embed", "frame", "keygen", "basefont",
]);

/** Unwrapped rather than dropped: the tag goes, the children stay. */
const UNWRAP = new Set(["html", "head", "body", "font", "center", "marquee", "blink"]);

/** Elements whose content is raw text, not markup — must be skipped literally. */
const RAW_TEXT = new Set([
  "script", "style", "xmp", "iframe", "noembed", "noframes", "textarea",
  "title", "plaintext",
]);

/** HTML void elements: never pushed onto the open-element stack. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/** Attributes allowed on any element. `aria-*` and `data-*` are allowed by prefix. */
// Untrusted class names could reuse compiled application utilities to overlay or hide the UI.
const GLOBAL_ATTRS = new Set(["id", "title", "dir", "lang", "role", "style"]);

/** Per-element attribute allowlist, on top of GLOBAL_ATTRS. */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name", "download", "hreflang", "type"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding"]),
  iframe: new Set([
    "src", "width", "height", "allow", "allowfullscreen", "frameborder",
    "referrerpolicy", "loading", "sandbox",
  ]),
  video: new Set(["src", "poster", "width", "height", "controls", "loop", "muted", "playsinline", "preload"]),
  audio: new Set(["src", "controls", "loop", "muted", "preload"]),
  source: new Set(["src", "type", "media", "sizes"]),
  track: new Set(["src", "kind", "srclang", "label", "default"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type", "reversed"]),
  li: new Set(["value"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  time: new Set(["datetime"]),
  details: new Set(["open"]),
};

/** Attributes whose value is a URL and therefore needs scheme checking. */
const URL_ATTRS = new Set(["href", "src", "cite", "poster"]);

/** URL schemes that may appear in an allowed URL attribute. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Hosts permitted as `<iframe src>`. An iframe is a whole browsing context —
 * an open one is a phishing frame on our origin's page, so the src host is
 * allowlisted rather than merely scheme-checked.
 */
const DEFAULT_IFRAME_HOSTS = [
  "youtube.com", "www.youtube.com", "youtube-nocookie.com",
  "www.youtube-nocookie.com", "youtu.be",
  "google.com", "www.google.com", "maps.google.com",
  "player.vimeo.com", "open.spotify.com", "w.soundcloud.com",
  "docs.google.com", "calendar.google.com", "drive.google.com",
  "www.loom.com", "loom.com",
];

/** `google.com` is only allowed to frame Maps — not Search, not Accounts. */
const GOOGLE_PATH_PREFIXES = ["/maps"];

/**
 * Every surviving iframe gets these restrictions, regardless of the pasted
 * attributes. Scripts and same-origin are required by the supported media
 * providers; top navigation, popups, forms, downloads and storage access stay
 * unavailable.
 */
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-presentation";
const IFRAME_REFERRER_POLICY = "strict-origin-when-cross-origin";
const IFRAME_PERMISSIONS = new Set([
  "accelerometer", "autoplay", "clipboard-write", "encrypted-media",
  "gyroscope", "picture-in-picture", "fullscreen", "web-share",
]);

/* --------------------------------------------------------------- entities */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  colon: ":", sol: "/", lpar: "(", rpar: ")", semi: ";", excl: "!",
  tab: "\t", newline: "\n", num: "#", period: ".", comma: ",", equals: "=",
};

/**
 * Decode HTML entities, INCLUDING the semicolon-less forms browsers accept.
 * This runs before every scheme check: `&#106;avascript:` and `&#X6A;avascript:`
 * are the same URL to a browser, and a filter that only sees the raw bytes is
 * a filter that can be walked past.
 */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    },
  );
}

/** Escape for a text node. Entities are decoded first so nothing double-escapes. */
function escapeText(raw: string): string {
  return decodeEntities(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for a double-quoted attribute value. */
function escapeAttr(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------- urls */

/**
 * Normalise a URL for judging: decode entities, delete control characters and
 * every whitespace character (browsers strip TAB/LF/CR inside URLs, which is
 * how `java\tscript:alert(1)` gets through naive filters), then trim.
 */
export function normalizeUrl(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeEntities(raw).replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export interface UrlCheck {
  ok: boolean;
  /** The cleaned value to emit. Only meaningful when `ok`. */
  value: string;
  /** Scheme found, lowercased, or "" for a relative URL. */
  scheme: string;
}

/** Scheme-check a URL attribute value. Relative URLs are allowed. */
export function checkUrl(raw: string): UrlCheck {
  const value = normalizeUrl(raw);
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!match) return { ok: true, value, scheme: "" };
  const scheme = match[1].toLowerCase();
  return { ok: SAFE_SCHEMES.has(scheme), value, scheme };
}

/** Host-check an `<iframe src>` against the embed allowlist. */
export function checkIframeSrc(raw: string, allowedHosts: Set<string>): UrlCheck & { host: string } {
  const base = checkUrl(raw);
  if (!base.ok) return { ...base, host: "" };
  if (base.scheme !== "http" && base.scheme !== "https") {
    return { ok: false, value: base.value, scheme: base.scheme, host: "" };
  }
  let url: URL;
  try {
    url = new URL(base.value);
  } catch {
    return { ok: false, value: base.value, scheme: base.scheme, host: "" };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, value: base.value, scheme: base.scheme, host: "" };
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    return { ok: false, value: base.value, scheme: base.scheme, host };
  }
  if (
    (host === "google.com" || host === "www.google.com") &&
    !GOOGLE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    return { ok: false, value: base.value, scheme: base.scheme, host };
  }
  return { ok: true, value: base.value, scheme: base.scheme, host };
}

/* ------------------------------------------------------------------ style */

/**
 * Inline CSS is allowlisted by property and value. URL-bearing, positioning,
 * visibility, animation and custom properties are intentionally unsupported:
 * even without script they can cover the app, spoof controls or make requests.
 */
const SAFE_STYLE_VALUES: Record<string, RegExp> = {
  border: /^(?:0(?:px)?|none)$/i,
  "border-style": /^(?:none|solid|dashed|dotted)$/i,
  "border-width": /^(?:0|[1-9]\d{0,2}px)$/i,
  "text-align": /^(?:start|end|left|right|center|justify)$/i,
  "vertical-align": /^(?:baseline|middle|top|bottom|text-top|text-bottom|sub|super)$/i,
  "font-style": /^(?:normal|italic|oblique)$/i,
  "font-weight": /^(?:normal|bold|bolder|lighter|[1-9]00)$/i,
  "text-decoration": /^(?:none|underline|line-through)$/i,
  "white-space": /^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i,
};

/**
 * Return a canonical declaration list only when every declaration is allowed.
 * Failing the entire attribute avoids hiding a dangerous declaration among
 * harmless ones and ensures the removal is visible in the sanitizer report.
 */
export function sanitizeStyle(raw: string): string | null {
  const value = decodeEntities(raw).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!value || /[{}@]/.test(value)) return null;

  const declarations = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (declarations.length === 0) return null;

  const safe: string[] = [];
  for (const declaration of declarations) {
    const colon = declaration.indexOf(":");
    if (colon <= 0) return null;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const cssValue = declaration.slice(colon + 1).trim();
    const validator = SAFE_STYLE_VALUES[property];
    if (!validator || !validator.test(cssValue)) return null;
    safe.push(`${property}:${cssValue}`);
  }
  return `${safe.join(";")};`;
}

/* ----------------------------------------------------------------- parser */

interface ParsedAttr {
  name: string;
  value: string | null;
}

interface ParsedTag {
  name: string;
  attrs: ParsedAttr[];
  selfClosing: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

/** Parse attributes starting at `from`, which sits inside `<name …`. */
function parseAttrs(input: string, from: number): { attrs: ParsedAttr[]; selfClosing: boolean; end: number } {
  const attrs: ParsedAttr[] = [];
  let i = from;
  let selfClosing = false;
  const n = input.length;

  while (i < n) {
    while (i < n && /\s/.test(input[i])) i += 1;
    if (i >= n) break;
    if (input[i] === ">") {
      i += 1;
      break;
    }
    if (input[i] === "/" && input[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }
    if (input[i] === "/") {
      i += 1;
      continue;
    }

    const nameStart = i;
    while (i < n && !/[\s=>/]/.test(input[i])) i += 1;
    const name = input.slice(nameStart, i);
    if (!name) {
      i += 1;
      continue;
    }

    while (i < n && /\s/.test(input[i])) i += 1;
    let value: string | null = null;
    if (input[i] === "=") {
      i += 1;
      while (i < n && /\s/.test(input[i])) i += 1;
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const valueStart = i;
        while (i < n && input[i] !== quote) i += 1;
        value = input.slice(valueStart, i);
        i += 1; // past the closing quote
      } else {
        const valueStart = i;
        while (i < n && !/[\s>]/.test(input[i])) i += 1;
        value = input.slice(valueStart, i);
      }
    }
    attrs.push({ name: name.toLowerCase(), value });
  }

  return { attrs, selfClosing, end: i };
}

/** Skip a raw-text element's body, returning the index just past `</name>`. */
function skipRawText(input: string, from: number, name: string): { content: string; end: number } {
  const pattern = new RegExp(`</${name}\\s*>`, "i");
  const rest = input.slice(from);
  const match = pattern.exec(rest);
  if (!match) return { content: rest, end: input.length };
  return { content: rest.slice(0, match.index), end: from + match.index + match[0].length };
}

/** Skip a whole element subtree by depth-counting `<name>` / `</name>`. */
function skipSubtree(input: string, from: number, name: string): number {
  const pattern = new RegExp(`<(/?)${name}\\b`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) {
      const close = input.indexOf(">", match.index);
      return close === -1 ? input.length : close + 1;
    }
  }
  return input.length;
}

/* -------------------------------------------------------------- sanitizer */

export interface SanitizeOptions {
  /** Extra hostnames permitted as `<iframe src>`, merged with the defaults. */
  allowedIframeHosts?: string[];
  /** Force `rel="noopener noreferrer"` on `target="_blank"` links. Default true. */
  hardenExternalLinks?: boolean;
}

export interface SanitizeResult {
  html: string;
  /** Deduped, human-readable list of what was removed, in first-seen order. */
  removed: string[];
}

/**
 * Sanitize an untrusted HTML fragment.
 *
 * Returns the safe HTML plus a report of everything stripped — the report is
 * the product difference: Sessionboard warns you it does not check; we tell you
 * exactly what we took out.
 */
export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizeResult {
  if (!input) return { html: "", removed: [] };

  const allowedHosts = new Set([
    ...DEFAULT_IFRAME_HOSTS,
    ...(options.allowedIframeHosts ?? []).map((host) => host.toLowerCase()),
  ]);
  const hardenLinks = options.hardenExternalLinks !== false;

  const removedSeen = new Set<string>();
  const removed: string[] = [];
  const note = (message: string) => {
    if (removedSeen.has(message)) return;
    removedSeen.add(message);
    removed.push(message);
  };

  let out = "";
  const stack: string[] = [];

  const emitEnd = (name: string) => {
    const index = stack.lastIndexOf(name);
    if (index === -1) return;
    for (let k = stack.length - 1; k >= index; k -= 1) out += `</${stack[k]}>`;
    stack.length = index;
  };

  const input_ = input;
  const n = input_.length;
  let i = 0;

  while (i < n) {
    const lt = input_.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(input_.slice(i));
      break;
    }
    if (lt > i) out += escapeText(input_.slice(i, lt));

    if (input_.startsWith("<!--", lt)) {
      const end = input_.indexOf("-->", lt + 4);
      note("HTML comment");
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input_.startsWith("<!", lt) || input_.startsWith("<?", lt)) {
      const end = input_.indexOf(">", lt);
      note("document declaration");
      i = end === -1 ? n : end + 1;
      continue;
    }

    const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(input_.slice(lt, lt + 80));
    if (!head) {
      // A stray `<` that starts no tag is literal text.
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const isEnd = head[1] === "/";
    const name = head[2].toLowerCase();
    const parsed = parseAttrs(input_, lt + head[0].length);
    const tag: ParsedTag = { name, attrs: parsed.attrs, selfClosing: parsed.selfClosing, end: parsed.end };

    if (isEnd) {
      emitEnd(name);
      i = tag.end;
      continue;
    }

    /* --- elements dropped along with everything inside them --- */
    if (DROP_WITH_CONTENT.has(name)) {
      note(`<${name}> element`);
      if (RAW_TEXT.has(name)) {
        // Deliberately BEFORE the self-closing check: HTML parsers do not honour
        // `<script/>`, they keep reading until `</script>`. Trusting the slash
        // here would emit the script body as text.
        i = skipRawText(input_, tag.end, name).end;
      } else if (tag.selfClosing) {
        i = tag.end;
      } else {
        i = skipSubtree(input_, tag.end, name);
      }
      continue;
    }

    /* --- void elements dropped outright --- */
    if (DROP_VOID.has(name)) {
      note(`<${name}> element`);
      i = tag.end;
      continue;
    }

    /* --- unknown or structural tags: drop the tag, keep the children --- */
    if (!ALLOWED_TAGS.has(name)) {
      if (!UNWRAP.has(name)) note(`<${name}> tag (contents kept)`);
      i = tag.end;
      continue;
    }

    /* --- an iframe is only allowed to frame an allowlisted host --- */
    if (name === "iframe") {
      const srcAttr = tag.attrs.find((attr) => attr.name === "src");
      const check = srcAttr?.value ? checkIframeSrc(srcAttr.value, allowedHosts) : null;
      if (!check?.ok) {
        note(
          check?.host
            ? `<iframe> from ${check.host} (host not on the embed allowlist)`
            : "<iframe> with a missing or unsafe src",
        );
        i = skipRawText(input_, tag.end, name).end;
        continue;
      }
    }

    /* --- attribute filtering --- */
    const kept: string[] = [];
    let hasBlankTarget = false;
    let relValue: string | null = null;

    for (const attr of tag.attrs) {
      const attrName = attr.name;

      if (attrName.startsWith("on")) {
        note(`${attrName}= event handler`);
        continue;
      }
      if (attrName === "srcdoc" || attrName === "formaction" || attrName === "xlink:href") {
        note(`${attrName}= attribute`);
        continue;
      }

      const allowedHere =
        GLOBAL_ATTRS.has(attrName) ||
        attrName.startsWith("aria-") ||
        attrName.startsWith("data-") ||
        (TAG_ATTRS[name]?.has(attrName) ?? false);

      if (!allowedHere) {
        note(`${attrName}= on <${name}>`);
        continue;
      }

      if (attr.value === null) {
        if (name === "iframe" && attrName !== "allowfullscreen") {
          note(`valueless ${attrName}= on <iframe>`);
          continue;
        }
        kept.push(attrName);
        continue;
      }

      if (attrName === "style") {
        const style = sanitizeStyle(attr.value);
        if (style === null) {
          note("unsafe inline style");
          continue;
        }
        kept.push(`style="${escapeAttr(style)}"`);
        continue;
      }

      if (name === "iframe" && ["sandbox", "referrerpolicy", "loading"].includes(attrName)) {
        // These are emitted with fixed safe values after all pasted attributes.
        continue;
      }

      if (name === "iframe" && attrName === "allow") {
        const permissions = attr.value
          .split(";")
          .map((entry) => entry.trim().split(/\s+/)[0]?.toLowerCase())
          .filter((permission): permission is string => Boolean(permission && IFRAME_PERMISSIONS.has(permission)));
        if (permissions.length > 0) {
          kept.push(`allow="${escapeAttr([...new Set(permissions)].join("; "))}"`);
        }
        if (permissions.length !== attr.value.split(";").filter((entry) => entry.trim()).length) {
          note("unsafe iframe permission");
        }
        continue;
      }

      if (name === "iframe" && attrName === "frameborder") {
        if (attr.value.trim() === "0") kept.push('frameborder="0"');
        else note("unsafe iframe frameborder");
        continue;
      }

      if (name === "iframe" && (attrName === "width" || attrName === "height")) {
        const dimension = attr.value.trim();
        if (/^[1-9]\d{0,3}$/.test(dimension) && Number(dimension) <= 4096) {
          kept.push(`${attrName}="${dimension}"`);
        } else {
          note(`unsafe iframe ${attrName}`);
        }
        continue;
      }

      if (URL_ATTRS.has(attrName)) {
        const check = attrName === "src" && name === "iframe"
          ? checkIframeSrc(attr.value, allowedHosts)
          : checkUrl(attr.value);
        if (!check.ok) {
          note(check.scheme ? `${check.scheme}: URL` : `unsafe ${attrName} URL`);
          continue;
        }
        kept.push(`${attrName}="${escapeAttr(check.value)}"`);
        continue;
      }

      if (attrName === "target") {
        const target = attr.value.trim().toLowerCase();
        if (target === "_blank") hasBlankTarget = true;
        kept.push(`target="${escapeAttr(target === "_blank" ? "_blank" : "_self")}"`);
        continue;
      }

      if (attrName === "rel") {
        relValue = attr.value;
        continue;
      }

      kept.push(`${attrName}="${escapeAttr(decodeEntities(attr.value))}"`);
    }

    if (name === "a") {
      const rels = new Set(
        (relValue ?? "")
          .split(/\s+/)
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean),
      );
      if (hardenLinks && hasBlankTarget) {
        rels.add("noopener");
        rels.add("noreferrer");
      }
      if (rels.size > 0) kept.push(`rel="${escapeAttr([...rels].join(" "))}"`);
    } else if (relValue !== null) {
      kept.push(`rel="${escapeAttr(decodeEntities(relValue))}"`);
    }

    if (name === "iframe") {
      kept.push(`sandbox="${IFRAME_SANDBOX}"`);
      kept.push(`referrerpolicy="${IFRAME_REFERRER_POLICY}"`);
      kept.push('loading="lazy"');
    }

    const isVoid = VOID_TAGS.has(name);
    out += `<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${isVoid ? " />" : ">"}`;
    if (!isVoid && !tag.selfClosing) stack.push(name);

    if (RAW_TEXT.has(name) && !isVoid && !tag.selfClosing) {
      // A kept iframe: its fallback content is markup we did not vet, and no
      // browser that supports iframes renders it. Drop the body, keep the frame.
      const raw = skipRawText(input_, tag.end, name);
      if (raw.content.trim()) note(`<${name}> fallback content`);
      emitEnd(name);
      i = raw.end;
      continue;
    }

    i = tag.end;
  }

  while (stack.length > 0) out += `</${stack.pop()}>`;

  return { html: out, removed };
}

/** Convenience wrapper for callers that only need the safe markup. */
export function sanitizeHtmlToString(input: string, options?: SanitizeOptions): string {
  return sanitizeHtml(input, options).html;
}
