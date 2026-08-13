import { describe, expect, it } from "vitest";

import {
  deriveProgrammeReadiness,
  type ProgrammeReadinessInput,
} from "./programme-readiness";

const READY: ProgrammeReadinessInput = {
  cfpForms: 1,
  openCfpForms: 1,
  abstracts: 4,
  pendingAbstracts: 0,
  unassignedPendingAbstracts: 0,
  queuedDecisions: 0,
  acceptedSpeakers: 2,
  incompleteSpeakerProfiles: 0,
  outstandingSpeakerTasks: 0,
  acceptedSessions: 2,
  unscheduledAcceptedSessions: 0,
  unpublishedAcceptedSessions: 0,
  agendaConflicts: 0,
};

function stage(input: ProgrammeReadinessInput, id: "cfp" | "reviews" | "speakers" | "agenda") {
  return deriveProgrammeReadiness(input).stages.find((entry) => entry.id === id)!;
}

describe("programme readiness — must fire", () => {
  it("calls out a missing CFP setup", () => {
    const cfp = stage({ ...READY, cfpForms: 0, openCfpForms: 0 }, "cfp");
    expect(cfp).toMatchObject({ status: "attention", actionLabel: "Set up the CFP" });
    expect(cfp.summary).toMatch(/no call-for-proposals form/i);
  });

  it("routes unassigned pending submissions to review setup", () => {
    const reviews = stage(
      { ...READY, pendingAbstracts: 2, unassignedPendingAbstracts: 1 },
      "reviews",
    );
    expect(reviews).toMatchObject({
      status: "attention",
      to: "/admin/reviews",
      actionLabel: "Assign reviews",
    });
    expect(reviews.details.join(" ")).toMatch(/1 pending submission.*without a review assignment/i);
  });

  it("calls out staged decisions even when every pending submission is assigned", () => {
    const reviews = stage({ ...READY, queuedDecisions: 2 }, "reviews");
    expect(reviews.status).toBe("attention");
    expect(reviews.details.join(" ")).toMatch(/2 decisions staged and ready to commit/i);
  });

  it("calls out incomplete accepted-speaker onboarding", () => {
    const speakers = stage(
      { ...READY, incompleteSpeakerProfiles: 1, outstandingSpeakerTasks: 3 },
      "speakers",
    );
    expect(speakers.status).toBe("attention");
    expect(speakers.details.join(" ")).toMatch(/missing a bio or headshot/i);
    expect(speakers.details.join(" ")).toMatch(/3 speaker tasks still outstanding/i);
  });

  it("routes programme conflicts to the conflict view", () => {
    const agenda = stage(
      {
        ...READY,
        unscheduledAcceptedSessions: 1,
        unpublishedAcceptedSessions: 1,
        agendaConflicts: 2,
      },
      "agenda",
    );
    expect(agenda).toMatchObject({
      status: "attention",
      to: "/admin/agenda?view=conflicts",
      actionLabel: "Resolve conflicts",
    });
    expect(agenda.details).toHaveLength(3);
  });
});

describe("programme readiness — must NOT fire", () => {
  it("treats a saved but non-open CFP as a neutral lifecycle state", () => {
    const result = deriveProgrammeReadiness({ ...READY, openCfpForms: 0 });
    const cfp = result.stages.find((entry) => entry.id === "cfp")!;
    expect(cfp.status).toBe("closed");
    expect(cfp.statusLabel).toBe("Not collecting");
    expect(result.attentionCount).toBe(0);
  });

  it("does not invent review or onboarding blockers before submissions arrive", () => {
    const result = deriveProgrammeReadiness({
      ...READY,
      abstracts: 0,
      acceptedSpeakers: 0,
      acceptedSessions: 0,
    });
    expect(result.stages.map((entry) => [entry.id, entry.status])).toEqual([
      ["cfp", "ready"],
      ["reviews", "waiting"],
      ["speakers", "waiting"],
      ["agenda", "waiting"],
    ]);
    expect(result.summary).toMatch(/no current blockers/i);
  });

  it("reports the completed lifecycle without false blockers", () => {
    const result = deriveProgrammeReadiness(READY);
    expect(result.attentionCount).toBe(0);
    expect(result.stages.map((entry) => entry.status)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
  });
});
