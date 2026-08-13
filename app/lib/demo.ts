/**
 * Demo-mode constants, shared by the seed script and the /demo route so the
 * one-click sign-ins can never drift from the seeded accounts.
 *
 * Keep this file dependency-free — `scripts/seed.mjs` reads these values too.
 */

export const DEMO_EVENT_SLUG = "frontier-ai-summit-2026";

export const DEMO_ACCOUNTS = {
  admin: {
    email: "admin@callboard.dev",
    fullName: "Ada Organiser",
    label: "Enter as admin",
    landing: "/admin",
  },
  speaker: {
    email: "speaker@callboard.dev",
    fullName: "Sam Speaker",
    label: "Enter as speaker",
    landing: "/portal",
  },
} as const;

export type DemoRole = keyof typeof DEMO_ACCOUNTS;
export const DEMO_ROLES = Object.keys(DEMO_ACCOUNTS) as DemoRole[];
