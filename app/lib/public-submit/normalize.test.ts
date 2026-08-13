import { describe, expect, it } from "vitest";

import {
  FORMAT_ANSWER_KEYS,
  LEVEL_ANSWER_KEYS,
  readNamedOptionAnswer,
  resolveFormatAndLevel,
  resolveNamedOption,
} from "./normalize";

const formats = [
  { id: "format-talk", name: "Talk" },
  { id: "format-workshop", name: "Workshop" },
] as const;

const levels = [{ id: "level-intermediate", name: "Intermediate" }] as const;

describe("resolveNamedOption", () => {
  it("must fire: resolves an exact name", () => {
    expect(resolveNamedOption("Talk", formats)).toBe("format-talk");
  });

  it("must fire: compares names case-insensitively", () => {
    expect(resolveNamedOption("workshop", formats)).toBe("format-workshop");
  });

  it("must fire: ignores surrounding whitespace", () => {
    expect(resolveNamedOption(" Workshop ", formats)).toBe("format-workshop");
  });

  it("must NOT fire: returns null for an unknown name", () => {
    expect(resolveNamedOption("Panel", formats)).toBeNull();
  });

  it("must NOT fire: refuses duplicate names instead of choosing the first id", () => {
    expect(
      resolveNamedOption("talk", [
        { id: "first-id", name: "Talk" },
        { id: "second-id", name: " TALK " },
      ]),
    ).toBeNull();
  });

  it("must NOT fire: returns null for every non-string answer", () => {
    for (const answer of [["Talk"], 1, { name: "Talk" }, null, undefined]) {
      expect(resolveNamedOption(answer, formats)).toBeNull();
    }
  });

  it("must NOT fire: returns null when there are no event rows", () => {
    expect(resolveNamedOption("Talk", [])).toBeNull();
  });

  it("must NOT fire: cannot match a format that exists only on another event", () => {
    const thisEventsFormats = [{ id: "this-event-workshop", name: "Workshop" }];
    expect(resolveNamedOption("Talk", thisEventsFormats)).toBeNull();
  });
});

describe("resolveFormatAndLevel", () => {
  it("resolves format and level from the canonical keys", () => {
    expect(
      resolveFormatAndLevel({
        answers: { format: "Talk", level: "Intermediate" },
        formats,
        levels,
      }),
    ).toEqual({ formatId: "format-talk", levelId: "level-intermediate" });
  });

  it("must fire: resolves level from each supported key", () => {
    for (const key of LEVEL_ANSWER_KEYS) {
      expect(
        resolveFormatAndLevel({ answers: { [key]: "Intermediate" }, formats, levels }).levelId,
      ).toBe("level-intermediate");
    }
  });

  it("uses the first present key even when its value is invalid", () => {
    const answers = { level: null, audience_level: "Intermediate" };
    expect(resolveFormatAndLevel({ answers, formats, levels }).levelId).toBeNull();
  });
});

describe("readNamedOptionAnswer", () => {
  it("returns submitted text without rewriting it", () => {
    expect(readNamedOptionAnswer({ format: " Workshop " }, FORMAT_ANSWER_KEYS)).toBe(
      " Workshop ",
    );
  });

  it("does not coerce non-string or blank answers for display", () => {
    expect(readNamedOptionAnswer({ format: ["Talk"] }, FORMAT_ANSWER_KEYS)).toBeNull();
    expect(readNamedOptionAnswer({ format: "   " }, FORMAT_ANSWER_KEYS)).toBeNull();
  });
});
