/**
 * Demo-mode constants, shared by the seed script and the /demo route so the
 * one-click sign-ins can never drift from the seeded accounts. The labels are
 * the button copy; app/lib/demo.test.ts pins them because the e2e specs and
 * README match these strings literally.
 *
 * Keep this file dependency-free — `scripts/seed.mjs` reads these values too.
 */

export const DEMO_EVENT_SLUG = "frontier-ai-summit-2026";

export const DEMO_ACCOUNTS = {
  admin: {
    email: "admin@callboard.dev",
    fullName: "Ada Organiser",
    label: "Enter organizer workspace",
    landing: "/admin",
  },
  speaker: {
    email: "speaker@callboard.dev",
    fullName: "Sam Speaker",
    label: "Enter speaker portal",
    landing: "/portal",
  },
} as const;

export type DemoRole = keyof typeof DEMO_ACCOUNTS;
export const DEMO_ROLES = Object.keys(DEMO_ACCOUNTS) as DemoRole[];
