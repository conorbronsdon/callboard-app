/**
 * Template rendering + the merge-field alias contract.
 *
 * The alias half matters more than it looks: `scripts/seed.mjs` already writes
 * `{{first_name}}` / `{{task_count}}` rows and WS1a's per-form confirmation copy
 * uses `{{event_name}}`. If the dotted canonical names did not resolve those,
 * every seeded template would render blanks — and blanks are exactly what a
 * "renders without throwing" test cannot see.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATES,
  MERGE_FIELDS,
  TEMPLATE_KEYS,
  isTemplateKey,
  mergeContext,
  previewContext,
  renderEmail,
  renderTemplate,
  unknownMergeFields,
} from "./templates";

describe("renderTemplate", () => {
  const context = mergeContext({
    "speaker.name": "Sam Speaker",
    "speaker.first_name": "Sam",
    "event.name": "Frontier AI Summit 2026",
    "session.title": "Shipping agents",
    "portal.url": "https://callboard.test/portal",
  });

  it("MUST-FIRE: substitutes canonical dotted fields", () => {
    expect(renderTemplate("Hi {{speaker.first_name}} — {{event.name}}", context)).toBe(
      "Hi Sam — Frontier AI Summit 2026",
    );
  });

  it("MUST-FIRE: the snake aliases resolve to the same value", () => {
    expect(renderTemplate("{{first_name}} / {{event_name}}", context)).toBe(
      "Sam / Frontier AI Summit 2026",
    );
    expect(renderTemplate("{{session_title}} @ {{portal_url}}", context)).toBe(
      "Shipping agents @ https://callboard.test/portal",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("{{  speaker.name  }}", context)).toBe("Sam Speaker");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(renderTemplate("{{first_name}}, {{first_name}}, {{first_name}}", context)).toBe(
      "Sam, Sam, Sam",
    );
  });

  it("MUST-NOT-FIRE: an unknown field never reaches the recipient as braces", () => {
    expect(renderTemplate("Hi {{speker.name}}!", context)).toBe("Hi !");
    expect(renderTemplate("{{ nonsense }}", context)).toBe("");
  });

  it("MUST-NOT-FIRE: text with no merge fields is passed through byte for byte", () => {
    const plain = "See you on stage. Curly braces { like this } are fine.";
    expect(renderTemplate(plain, context)).toBe(plain);
  });

  it("renders a known field with no value as empty, not as the literal", () => {
    expect(renderTemplate("[{{session.room}}]", context)).toBe("[]");
  });
});

describe("unknownMergeFields", () => {
  it("MUST-FIRE: reports a typo so the editor can warn", () => {
    expect(unknownMergeFields("Hi {{speker.name}} and {{event.nmae}}")).toEqual([
      "speker.name",
      "event.nmae",
    ]);
  });

  it("MUST-NOT-FIRE: says nothing about valid fields or valid aliases", () => {
    expect(unknownMergeFields("{{speaker.name}} {{first_name}} {{task_count}}")).toEqual([]);
    expect(unknownMergeFields("no fields here")).toEqual([]);
  });
});

describe("merge-field catalog", () => {
  it("has no duplicate keys or aliases — an alias collision would shadow a field", () => {
    const names = MERGE_FIELDS.flatMap((field) => [field.key, ...field.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every field a preview sample, so the preview is never half-blank", () => {
    const preview = previewContext();
    for (const field of MERGE_FIELDS) {
      expect(preview[field.key], field.key).toBeTruthy();
      for (const alias of field.aliases) expect(preview[alias], alias).toBe(preview[field.key]);
    }
  });
});

describe("default templates", () => {
  it("covers every key with a non-empty subject and body", () => {
    for (const key of TEMPLATE_KEYS) {
      const template = DEFAULT_TEMPLATES[key];
      expect(template.key).toBe(key);
      expect(template.subject.trim().length).toBeGreaterThan(0);
      expect(template.body.trim().length).toBeGreaterThan(0);
      expect(template.trigger.trim().length).toBeGreaterThan(0);
    }
  });

  it("MUST-NOT-FIRE: no default template references an unknown merge field", () => {
    for (const key of TEMPLATE_KEYS) {
      const template = DEFAULT_TEMPLATES[key];
      expect(unknownMergeFields(`${template.subject}\n${template.body}`), key).toEqual([]);
    }
  });

  it("renders every default against the preview context with nothing left over", () => {
    const context = previewContext();
    for (const key of TEMPLATE_KEYS) {
      const rendered = renderEmail(DEFAULT_TEMPLATES[key], context);
      expect(rendered.subject).not.toMatch(/\{\{/);
      expect(rendered.text).not.toMatch(/\{\{/);
      expect(rendered.subject.length).toBeGreaterThan(0);
    }
  });

  it("accepts the seeded snake-case rows scripts/seed.mjs writes", () => {
    // Verbatim from scripts/seed.mjs EMAIL_TEMPLATES.
    const rendered = renderEmail(
      {
        key: "task_reminder",
        subject: "{{task_count}} things left before {{event_name}}",
        body: "Hi {{first_name}}, you still have {{task_count}} open task(s).",
      },
      mergeContext({
        "speaker.first_name": "Rina",
        "event.name": "Frontier AI Summit 2026",
        "task.count": "3",
      }),
    );
    expect(rendered.subject).toBe("3 things left before Frontier AI Summit 2026");
    expect(rendered.text).toBe("Hi Rina, you still have 3 open task(s).");
  });
});

describe("renderEmail fallbacks", () => {
  const context = previewContext();

  it("falls back to the built-in subject when an admin blanks it", () => {
    const rendered = renderEmail(
      { key: "schedule_invite", subject: "   ", body: "Body kept." },
      context,
    );
    expect(rendered.subject).toBe(
      renderTemplate(DEFAULT_TEMPLATES.schedule_invite.subject, context),
    );
    expect(rendered.text).toBe("Body kept.");
  });

  it("falls back to the built-in body when an admin blanks it", () => {
    const rendered = renderEmail(
      { key: "task_reminder", subject: "Custom subject", body: "" },
      context,
    );
    expect(rendered.subject).toBe("Custom subject");
    expect(rendered.text).toBe(renderTemplate(DEFAULT_TEMPLATES.task_reminder.body, context));
  });
});

describe("isTemplateKey", () => {
  it("MUST-FIRE on a real key, MUST-NOT-FIRE on anything else", () => {
    expect(isTemplateKey("task_reminder")).toBe(true);
    expect(isTemplateKey("acceptance")).toBe(false);
    expect(isTemplateKey(undefined)).toBe(false);
    expect(isTemplateKey("")).toBe(false);
  });
});
