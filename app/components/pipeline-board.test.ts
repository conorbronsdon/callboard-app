import { describe, expect, it } from "vitest";

import { PIPELINE_STAGES } from "~/db/schema";

import { pipelineDropIntent } from "./pipeline-board";

describe("pipelineDropIntent", () => {
  it.each(["prospect", "in_conversation", "declined"] as const)(
    "maps a drop onto the %s column to the exact audited move fields",
    (stage) => {
      expect(pipelineDropIntent("entry-123", stage, PIPELINE_STAGES)).toEqual({
        intent: "move",
        entryId: "entry-123",
        stage,
      });
    },
  );

  it("maps a drop onto the entry's current stage and lets the server no-op it", () => {
    expect(pipelineDropIntent("entry-current", "contacted", PIPELINE_STAGES)).toEqual({
      intent: "move",
      entryId: "entry-current",
      stage: "contacted",
    });
  });

  it.each([null, undefined, "not-a-stage", 42, { id: "confirmed" }])(
    "MUST NOT FIRE: rejects a non-column drop target %#",
    (overId) => {
      expect(pipelineDropIntent("entry-123", overId, PIPELINE_STAGES)).toBeNull();
    },
  );

  it.each([
    { entryId: "", overId: "prospect" },
    { entryId: "   ", overId: "prospect" },
    { entryId: "entry-123", overId: "" },
    { entryId: "", overId: null },
  ])("MUST NOT FIRE: rejects missing drop fields %#", ({ entryId, overId }) => {
    expect(pipelineDropIntent(entryId, overId, PIPELINE_STAGES)).toBeNull();
  });
});
