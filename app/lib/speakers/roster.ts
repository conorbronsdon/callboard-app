import type { SpeakerStatus } from "~/db/schema";

export interface SpeakerStatusBadge {
  status: SpeakerStatus;
  label: string;
  tone: string;
}

export const SPEAKER_STATUS_BADGES: readonly SpeakerStatusBadge[] = [
  {
    status: "invited",
    label: "Invited",
    tone: "bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100",
  },
  {
    status: "confirmed",
    label: "Confirmed",
    tone: "bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100",
  },
  {
    status: "onboarding",
    label: "Onboarding",
    tone: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  },
  {
    status: "ready",
    label: "Ready",
    tone: "bg-emerald-700 text-white dark:bg-emerald-600",
  },
] as const;

const SPEAKER_STATUS_VALUES: readonly string[] = SPEAKER_STATUS_BADGES.map(
  (entry) => entry.status,
);

export function isSpeakerStatus(value: unknown): value is SpeakerStatus {
  return typeof value === "string" && SPEAKER_STATUS_VALUES.includes(value);
}

export function speakerStatusBadge(status: SpeakerStatus): SpeakerStatusBadge {
  return (
    SPEAKER_STATUS_BADGES.find((entry) => entry.status === status) ??
    SPEAKER_STATUS_BADGES[0]
  );
}

