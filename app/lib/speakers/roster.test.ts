import { describe, expect, it } from "vitest";

import { SPEAKER_STATUSES } from "~/db/schema";

import { isSpeakerStatus, SPEAKER_STATUS_BADGES } from "./roster";

describe("speaker workflow statuses", () => {
  it("covers the schema enum exactly", () => {
    expect(SPEAKER_STATUS_BADGES.map((entry) => entry.status).sort()).toEqual(
      [...SPEAKER_STATUSES].sort(),
    );
    expect(SPEAKER_STATUS_BADGES.map((entry) => entry.label)).toEqual([
      "Invited",
      "Confirmed",
      "Onboarding",
      "Ready",
    ]);
  });

  it("accepts every known value and rejects an unknown value", () => {
    expect(SPEAKER_STATUSES.every(isSpeakerStatus)).toBe(true);
    expect(isSpeakerStatus("scheduled")).toBe(false);
  });
});

