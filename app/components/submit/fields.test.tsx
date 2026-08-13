import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldInput } from "~/components/submit/fields";
import { countChars } from "~/lib/form-schema";
import type { FormFieldRef } from "~/lib/form-schema";

/*
 * The control's displayed value and the counter's number are deliberately
 * different readings of the same answer.
 *
 * A `wysiwyg` field is stored as HTML, so `countChars` strips the markup
 * before counting — `<p>hi</p>` costs 2 of the budget, not 11. That reading is
 * correct for a counter and wrong for a controlled input: the strip path ends
 * in `.trim()`, so when the textarea's `value` came from it, every keystroke
 * round-tripped through the strip and a just-typed space — a TRAILING space at
 * that instant — was deleted before it could be rendered. Typing "one two"
 * produced "onetwo". Playwright never saw it because `fill()` sets the whole
 * string atomically, so no intermediate value ever ends in a space.
 *
 * These tests pin both halves at once: the control shows the answer verbatim,
 * the counter still counts stripped.
 */

const decodeEntities = (html: string): string =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function textareaValue(html: string): string {
  const match = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  if (!match) throw new Error(`no <textarea> in markup: ${html}`);
  return decodeEntities(match[1]);
}

function counterText(html: string, key: string): string {
  const match = new RegExp(
    `data-testid="counter-${key}"[^>]*>([\\s\\S]*?)</span>`,
  ).exec(html);
  if (!match) throw new Error(`no counter for "${key}" in markup: ${html}`);
  return decodeEntities(match[1].replace(/<!--[\s\S]*?-->/g, ""));
}

function field(overrides: Partial<FormFieldRef> = {}): FormFieldRef {
  return {
    fieldId: "field-abstract",
    key: "abstract",
    type: "wysiwyg",
    label: "Abstract",
    scope: "submission",
    order: 0,
    required: true,
    ...overrides,
  };
}

const markup = (value: string, overrides: Partial<FormFieldRef> = {}): string =>
  renderToStaticMarkup(<FieldInput field={field(overrides)} value={value} required />);

describe("FieldInput shows the answer it was given", () => {
  it("MUST FIRE: a wysiwyg value ending in a space keeps that space", () => {
    // The regression itself. Controlled + trim = the user cannot type a space.
    expect(textareaValue(markup("a "))).toBe("a ");
  });

  it("MUST FIRE: a wysiwyg value with internal spaces renders verbatim", () => {
    expect(textareaValue(markup("hello world"))).toBe("hello world");
  });

  it("MUST FIRE: stored markup is displayed, not silently stripped", () => {
    // Display honesty: a stripped display plus a submit persists the stripped
    // text, so an edit round-trip used to destroy the author's markup.
    expect(textareaValue(markup("<b>x</b>"))).toBe("<b>x</b>");
  });

  it("MUST FIRE: a textarea field also keeps a trailing space", () => {
    // Never broken (`textarea` is not an HTML type), so this is the control:
    // it stays green across the fix and proves the harness can see a space.
    expect(textareaValue(markup("a ", { type: "textarea" }))).toBe("a ");
  });

  it("MUST NOT FIRE: an empty answer renders an empty control, not 'null'", () => {
    const html = renderToStaticMarkup(
      <FieldInput field={field()} value={null} required />,
    );
    expect(textareaValue(html)).toBe("");
  });
});

describe("the wysiwyg counter still counts stripped characters", () => {
  it("MUST STILL FIRE: <p>hi</p> counts 2, and is shown verbatim in the same render", () => {
    const html = markup("<p>hi</p>", { validation: { maxLength: 500 } });

    // Counting semantics are unchanged by the display fix…
    expect(countChars("<p>hi</p>", "wysiwyg")).toBe(2);
    expect(counterText(html, "abstract")).toBe("2/500");
    // …while the control shows what is actually stored.
    expect(textareaValue(html)).toBe("<p>hi</p>");
  });

  it("MUST STILL FIRE: entities count as one character each", () => {
    const html = markup("a&nbsp;b", { validation: { maxLength: 10 } });

    expect(counterText(html, "abstract")).toBe("3/10");
    expect(textareaValue(html)).toBe("a&nbsp;b");
  });
});
