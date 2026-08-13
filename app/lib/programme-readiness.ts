import type { EmbedWidgetId } from "~/lib/embeds";

export type ReadinessStatus = "ready" | "attention" | "waiting" | "closed";

export interface ReadinessStage {
  id: "cfp" | "reviews" | "speakers" | "agenda";
  title: string;
  status: ReadinessStatus;
  statusLabel: string;
  summary: string;
  details: string[];
  to: string;
  actionLabel: string;
  embedWidget: EmbedWidgetId | null;
}

export interface ProgrammeReadinessInput {
  cfpForms: number;
  openCfpForms: number;
  abstracts: number;
  pendingAbstracts: number;
  unassignedPendingAbstracts: number;
  queuedDecisions: number;
  acceptedSpeakers: number;
  incompleteSpeakerProfiles: number;
  outstandingSpeakerTasks: number;
  acceptedSessions: number;
  unscheduledAcceptedSessions: number;
  unpublishedAcceptedSessions: number;
  agendaConflicts: number;
}

export interface ProgrammeReadiness {
  attentionCount: number;
  summary: string;
  stages: ReadinessStage[];
}

export interface EventSetupStep {
  id:
    | "cfp-form"
    | "open-submissions"
    | "reviewers"
    | "review-decide"
    | "schedule"
    | "tell-speakers"
    | "publish"
    | "embed";
  title: string;
  description: string;
  done: boolean;
  to: string;
  actionLabel: string;
}

export interface EventSetupChecklistInput {
  cfpForms: number;
  openCfpForms: number;
  abstracts: number;
  reviewsReady: boolean;
  reviewRounds: number;
  reviewers: number;
  acceptedSessions: number;
  unscheduledAcceptedSessions: number;
  heldForUninformed: number;
  unpublishedAcceptedSessions: number;
  savedEmbeds: number;
}

export interface EventSetupChecklist {
  steps: EventSetupStep[];
  nextStepId: EventSetupStep["id"] | null;
  allDone: boolean;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function cfpStage(input: ProgrammeReadinessInput): ReadinessStage {
  if (input.cfpForms === 0) {
    return {
      id: "cfp",
      title: "Collect proposals",
      status: "attention",
      statusLabel: "Needs setup",
      summary: "No call-for-proposals form exists yet.",
      details: ["Create a form before sharing a submission link."],
      to: "/admin/forms",
      actionLabel: "Set up the CFP",
      embedWidget: null,
    };
  }

  if (input.openCfpForms === 0) {
    return {
      id: "cfp",
      title: "Collect proposals",
      status: "closed",
      statusLabel: "Not collecting",
      summary: "No CFP form is accepting submissions right now.",
      details: [
        `${plural(input.cfpForms, "CFP form")} saved; open one only when collection should be live.`,
      ],
      to: "/admin/forms",
      actionLabel: "Review forms",
      embedWidget: null,
    };
  }

  return {
    id: "cfp",
    title: "Collect proposals",
    status: "ready",
    statusLabel: "Open",
    summary: `${plural(input.openCfpForms, "CFP form")} accepting submissions.`,
    details: [`${plural(input.abstracts, "submission")} received so far.`],
    to: "/admin/forms?status=open",
    actionLabel: "Manage open forms",
    embedWidget: null,
  };
}

function reviewStage(input: ProgrammeReadinessInput): ReadinessStage {
  if (input.abstracts === 0) {
    return {
      id: "reviews",
      title: "Review and decide",
      status: "waiting",
      statusLabel: "Waiting",
      summary: "No submissions have arrived yet.",
      details: ["Review work will appear here after the first proposal."],
      to: "/admin/reviews",
      actionLabel: "Prepare reviews",
      embedWidget: null,
    };
  }

  const details: string[] = [];
  if (input.unassignedPendingAbstracts > 0) {
    details.push(`${plural(input.unassignedPendingAbstracts, "pending submission")} without a review assignment.`);
  }
  if (input.pendingAbstracts > 0) {
    details.push(`${plural(input.pendingAbstracts, "submission")} still awaiting a decision.`);
  }
  if (input.queuedDecisions > 0) {
    details.push(`${plural(input.queuedDecisions, "decision")} staged and ready to commit.`);
  }

  if (details.length > 0) {
    return {
      id: "reviews",
      title: "Review and decide",
      status: "attention",
      statusLabel: "Needs attention",
      summary: "The review pipeline still has work to finish.",
      details,
      to: input.unassignedPendingAbstracts > 0 ? "/admin/reviews" : "/admin/submissions?tab=pending",
      actionLabel: input.unassignedPendingAbstracts > 0 ? "Assign reviews" : "Finish decisions",
      embedWidget: null,
    };
  }

  return {
    id: "reviews",
    title: "Review and decide",
    status: "ready",
    statusLabel: "Complete",
    summary: "Every submission has a committed decision.",
    details: [`${plural(input.abstracts, "submission")} processed.`],
    to: "/admin/submissions",
    actionLabel: "View submissions",
    embedWidget: null,
  };
}

function speakerStage(input: ProgrammeReadinessInput): ReadinessStage {
  if (input.acceptedSpeakers === 0) {
    return {
      id: "speakers",
      title: "Onboard speakers",
      status: "waiting",
      statusLabel: "Waiting",
      summary: "No accepted speakers need onboarding yet.",
      details: ["Profiles and assigned tasks appear after a proposal is accepted."],
      to: "/admin/speakers",
      actionLabel: "View speakers",
      embedWidget: null,
    };
  }

  const details: string[] = [];
  if (input.incompleteSpeakerProfiles > 0) {
    details.push(
      `${plural(input.incompleteSpeakerProfiles, "accepted speaker")} missing a bio or headshot.`,
    );
  }
  if (input.outstandingSpeakerTasks > 0) {
    details.push(`${plural(input.outstandingSpeakerTasks, "speaker task")} still outstanding.`);
  }

  if (details.length > 0) {
    return {
      id: "speakers",
      title: "Onboard speakers",
      status: "attention",
      statusLabel: "Needs attention",
      summary: "Accepted speakers still have onboarding work.",
      details,
      to: "/admin/speakers",
      actionLabel: "Follow up with speakers",
      embedWidget: "speakers",
    };
  }

  return {
    id: "speakers",
    title: "Onboard speakers",
    status: "ready",
    statusLabel: "Ready",
    summary: "Accepted speaker profiles and tasks are complete.",
    details: [`${plural(input.acceptedSpeakers, "accepted speaker")} ready for the programme.`],
    to: "/admin/speakers",
    actionLabel: "View speakers",
    embedWidget: "speakers",
  };
}

function agendaStage(input: ProgrammeReadinessInput): ReadinessStage {
  if (input.acceptedSessions === 0) {
    return {
      id: "agenda",
      title: "Publish the agenda",
      status: "waiting",
      statusLabel: "Waiting",
      summary: "No accepted sessions are ready to schedule yet.",
      details: ["Accepted proposals become programme sessions automatically."],
      to: "/admin/agenda",
      actionLabel: "Open the agenda",
      embedWidget: null,
    };
  }

  const details: string[] = [];
  if (input.unscheduledAcceptedSessions > 0) {
    details.push(
      `${plural(input.unscheduledAcceptedSessions, "accepted session")} missing a complete time or room.`,
    );
  }
  if (input.agendaConflicts > 0) {
    details.push(`${plural(input.agendaConflicts, "schedule conflict")} to resolve.`);
  }
  if (input.unpublishedAcceptedSessions > 0) {
    details.push(`${plural(input.unpublishedAcceptedSessions, "accepted session")} not public yet.`);
  }

  if (details.length > 0) {
    return {
      id: "agenda",
      title: "Publish the agenda",
      status: "attention",
      statusLabel: "Needs attention",
      summary: "The public programme is not fully ready.",
      details,
      to: input.agendaConflicts > 0 ? "/admin/agenda?view=conflicts" : "/admin/agenda",
      actionLabel: input.agendaConflicts > 0 ? "Resolve conflicts" : "Finish the agenda",
      embedWidget: "agenda",
    };
  }

  return {
    id: "agenda",
    title: "Publish the agenda",
    status: "ready",
    statusLabel: "Published",
    summary: "Every accepted session is scheduled and public.",
    details: [`${plural(input.acceptedSessions, "accepted session")} on the public agenda.`],
    to: "/admin/agenda",
    actionLabel: "View the agenda",
    embedWidget: "agenda",
  };
}

export function deriveProgrammeReadiness(input: ProgrammeReadinessInput): ProgrammeReadiness {
  const stages = [cfpStage(input), reviewStage(input), speakerStage(input), agendaStage(input)];
  const attentionCount = stages.filter((stage) => stage.status === "attention").length;

  return {
    attentionCount,
    summary:
      attentionCount === 0
        ? "No current blockers. Keep an eye on waiting stages as the event progresses."
        : `${plural(attentionCount, "area")} need attention before the programme is ready.`,
    stages,
  };
}

function cfpFormStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "cfp-form",
    title: "Create your call-for-proposals form",
    description: "Build the form speakers will use to submit a talk.",
    done: input.cfpForms > 0,
    to: "/admin/forms",
    actionLabel: "Create a form",
  };
}

function openSubmissionsStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "open-submissions",
    title: "Open submissions",
    description: "Turn the form on so people can start submitting.",
    done: input.openCfpForms > 0,
    to: "/admin/forms?status=open",
    actionLabel: "Open the form",
  };
}

function reviewersStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "reviewers",
    title: "Invite reviewers",
    description: "Set up a review round and add the people who'll read submissions.",
    done: input.reviewRounds > 0 && input.reviewers > 0,
    to: "/admin/reviews",
    actionLabel: "Set up reviewers",
  };
}

function reviewDecideStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "review-decide",
    title: "Review and decide",
    description: "Work through submissions and accept or decline each one.",
    done: input.abstracts > 0 && input.reviewsReady,
    to: "/admin/submissions",
    actionLabel: "Review submissions",
  };
}

function scheduleStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "schedule",
    title: "Schedule accepted sessions",
    description: "Give every accepted talk a time and a room.",
    done: input.acceptedSessions > 0 && input.unscheduledAcceptedSessions === 0,
    to: "/admin/agenda",
    actionLabel: "Open the agenda",
  };
}

function tellSpeakersStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "tell-speakers",
    title: "Tell speakers",
    description: "Let accepted speakers know before the programme goes public.",
    done: input.acceptedSessions > 0 && input.heldForUninformed === 0,
    to: "/admin/agenda",
    actionLabel: "Review speaker holds",
  };
}

function publishStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "publish",
    title: "Publish the programme",
    description: "Make the accepted schedule visible to the public.",
    done: input.acceptedSessions > 0 && input.unpublishedAcceptedSessions === 0,
    to: "/admin/agenda",
    actionLabel: "Publish sessions",
  };
}

function embedStep(input: EventSetupChecklistInput): EventSetupStep {
  return {
    id: "embed",
    title: "Embed it on your site",
    description: "Grab ready-to-paste code so your website shows the live programme.",
    done: input.savedEmbeds > 0,
    to: "/admin/embeds",
    actionLabel: "Get embed code",
  };
}

/** Derive the organizer's event-building journey from current event data. */
export function deriveEventSetupChecklist(
  input: EventSetupChecklistInput,
): EventSetupChecklist {
  const steps = [
    cfpFormStep(input),
    openSubmissionsStep(input),
    reviewersStep(input),
    reviewDecideStep(input),
    scheduleStep(input),
    tellSpeakersStep(input),
    publishStep(input),
    embedStep(input),
  ];
  const nextStepId = steps.find((step) => !step.done)?.id ?? null;

  return {
    steps,
    nextStepId,
    allDone: nextStepId === null,
  };
}
