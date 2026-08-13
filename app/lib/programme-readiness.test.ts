import { describe, expect, it } from "vitest";

import {
  deriveEventSetupChecklist,
  deriveProgrammeReadiness,
  type EventSetupChecklistInput,
  type EventSetupStep,
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
  it.each([
    ["attention", { incompleteSpeakerProfiles: 1 }],
    ["ready", { incompleteSpeakerProfiles: 0 }],
  ])("exposes the speakers embed when accepted speakers are %s", (_state, overrides) => {
    expect(
      stage(
        { ...READY, acceptedSpeakers: 1, outstandingSpeakerTasks: 0, ...overrides },
        "speakers",
      ).embedWidget,
    ).toBe("speakers");
  });

  it.each([
    ["attention", { unpublishedAcceptedSessions: 1 }],
    ["ready", { unpublishedAcceptedSessions: 0 }],
  ])("exposes the agenda embed when accepted sessions are %s", (_state, overrides) => {
    expect(
      stage(
        {
          ...READY,
          acceptedSessions: 1,
          unscheduledAcceptedSessions: 0,
          agendaConflicts: 0,
          ...overrides,
        },
        "agenda",
      ).embedWidget,
    ).toBe("agenda");
  });

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
  it("does not expose empty speaker or agenda widgets", () => {
    expect(stage({ ...READY, acceptedSpeakers: 0 }, "speakers").embedWidget).toBeNull();
    expect(stage({ ...READY, acceptedSessions: 0 }, "agenda").embedWidget).toBeNull();
  });

  it.each([
    ["CFP missing", { cfpForms: 0, openCfpForms: 0 }],
    ["CFP closed", { cfpForms: 1, openCfpForms: 0 }],
    ["CFP open", { cfpForms: 1, openCfpForms: 1 }],
    ["reviews waiting", { abstracts: 0 }],
    ["reviews need assignment", { abstracts: 1, pendingAbstracts: 1, unassignedPendingAbstracts: 1 }],
    ["reviews need decisions", { abstracts: 1, pendingAbstracts: 1, unassignedPendingAbstracts: 0 }],
    ["reviews have a queue", { abstracts: 1, queuedDecisions: 1 }],
    ["reviews complete", { abstracts: 1, pendingAbstracts: 0, queuedDecisions: 0 }],
  ])("never exposes a CFP or review embed in the %s state", (_state, overrides) => {
    const result = deriveProgrammeReadiness({ ...READY, ...overrides });
    expect(result.stages.find((entry) => entry.id === "cfp")?.embedWidget).toBeNull();
    expect(result.stages.find((entry) => entry.id === "reviews")?.embedWidget).toBeNull();
  });

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

const EVENT_SETUP_DONE: EventSetupChecklistInput = {
  cfpForms: 1,
  openCfpForms: 1,
  abstracts: 4,
  reviewsReady: true,
  reviewRounds: 1,
  reviewers: 2,
  acceptedSessions: 2,
  unscheduledAcceptedSessions: 0,
  heldForUninformed: 0,
  unpublishedAcceptedSessions: 0,
  savedEmbeds: 1,
};

function setupStep(input: EventSetupChecklistInput, id: EventSetupStep["id"]) {
  return deriveEventSetupChecklist(input).steps.find((entry) => entry.id === id)!;
}

describe("event setup checklist — must fire", () => {
  it("reports the completed journey without a next action", () => {
    const result = deriveEventSetupChecklist(EVENT_SETUP_DONE);
    expect(result.allDone).toBe(true);
    expect(result.nextStepId).toBeNull();
    expect(result.steps.every((entry) => entry.done)).toBe(true);
  });

  it.each([
    ["cfp-form", { cfpForms: 0 }],
    ["open-submissions", { openCfpForms: 0 }],
    ["reviewers", { reviewRounds: 0 }],
    ["review-decide", { reviewsReady: false }],
    ["schedule", { unscheduledAcceptedSessions: 1 }],
    ["tell-speakers", { heldForUninformed: 1 }],
    ["publish", { unpublishedAcceptedSessions: 1 }],
    ["embed", { savedEmbeds: 0 }],
  ] satisfies [EventSetupStep["id"], Partial<EventSetupChecklistInput>][]) (
    "marks %s as the next action when only that step is incomplete",
    (id, overrides) => {
      const result = deriveEventSetupChecklist({ ...EVENT_SETUP_DONE, ...overrides });
      expect(result.steps.find((entry) => entry.id === id)?.done).toBe(false);
      expect(result.nextStepId).toBe(id);
      expect(result.allDone).toBe(false);
    },
  );

  it("chooses the first incomplete step when later steps are also incomplete", () => {
    const result = deriveEventSetupChecklist({
      ...EVENT_SETUP_DONE,
      reviewsReady: false,
      acceptedSessions: 0,
      savedEmbeds: 0,
    });
    expect(result.steps.slice(0, 3).every((entry) => entry.done)).toBe(true);
    expect(result.steps.slice(3).every((entry) => !entry.done)).toBe(true);
    expect(result.nextStepId).toBe("review-decide");
  });

  it("links steps directly to their action screens", () => {
    expect(setupStep(EVENT_SETUP_DONE, "cfp-form")).toMatchObject({
      to: "/admin/forms",
      actionLabel: "Create a form",
    });
    expect(setupStep(EVENT_SETUP_DONE, "embed")).toMatchObject({
      to: "/admin/embeds",
      actionLabel: "Get embed code",
    });
  });
});

describe("event setup checklist — must NOT fire", () => {
  it.each([
    ["cfp-form", { reviewers: 0 }],
    ["open-submissions", { savedEmbeds: 0 }],
    ["reviewers", { cfpForms: 0 }],
    ["review-decide", { unscheduledAcceptedSessions: 1 }],
    ["schedule", { abstracts: 0 }],
    ["tell-speakers", { unpublishedAcceptedSessions: 1 }],
    ["publish", { heldForUninformed: 1 }],
    ["embed", { reviewsReady: false }],
  ] satisfies [EventSetupStep["id"], Partial<EventSetupChecklistInput>][]) (
    "does not change %s when another step becomes incomplete",
    (id, overrides) => {
      expect(setupStep({ ...EVENT_SETUP_DONE, ...overrides }, id).done).toBe(true);
    },
  );
});
