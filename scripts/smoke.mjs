#!/usr/bin/env node
/**
 * Post-deploy smoke test. The profile is mandatory because demo and production
 * intentionally have different security and data contracts:
 *
 *   npm run smoke:demo -- https://callboard.<subdomain>.workers.dev
 *   npm run smoke:production -- https://callboard.example.com
 */
const args = process.argv.slice(2);
const requestedProfile =
  args.includes("--demo")
    ? "demo"
    : args.includes("--production")
      ? "production"
      : process.env.CALLBOARD_SMOKE_PROFILE;
const profile =
  requestedProfile === "demo" || requestedProfile === "production" ? requestedProfile : null;
const targetArg = args.find((arg) => !arg.startsWith("--"));
const url = (targetArg ?? process.env.CALLBOARD_URL ?? "").replace(/\/$/, "");

if (!profile) {
  console.error("smoke: choose an explicit profile: --demo or --production");
  process.exit(1);
}
if (!url) {
  console.error(
    [
      "smoke: no target URL.",
      "",
      "  npm run smoke:demo -- https://callboard.<subdomain>.workers.dev",
      "  npm run smoke:production -- https://callboard.example.com",
      "",
      "or set CALLBOARD_URL before deploy.",
    ].join("\n"),
  );
  process.exit(1);
}

const commonChecks = [
  {
    name: "public home renders from D1 with hardened headers",
    path: "/",
    expectStatus: 200,
    expectBody: /callboard/i,
    expectHeaders: {
      "x-content-type-options": /nosniff/i,
      "x-frame-options": /deny/i,
      "content-security-policy": /frame-ancestors 'none'/i,
    },
  },
  {
    name: "developer documentation renders",
    path: "/developers",
    expectStatus: 200,
    expectBody: /Public API/i,
  },
  {
    name: "OpenAPI document is machine-readable",
    path: "/v1/openapi.json",
    expectStatus: 200,
    expectBody: /"openapi"\s*:\s*"3\./i,
    expectHeaders: { "content-type": /application\/json/i },
  },
  {
    name: "runtime write dependencies are ready without mutation",
    path: "/ready",
    expectStatus: 200,
    expectBody: /"ready"\s*:\s*true/i,
    expectHeaders: {
      "content-type": /application\/json/i,
      "cache-control": /no-store/i,
    },
  },
  {
    name: "login page renders",
    path: "/login",
    expectStatus: 200,
    expectBody: /Email me a link/i,
  },
  {
    name: "portal redirects anonymous users to /login",
    path: "/portal",
    expectRedirectTo: /\/login/,
  },
  {
    name: "admin redirects anonymous users to /login",
    path: "/admin",
    expectRedirectTo: /\/login/,
  },
  {
    name: "job runner rejects GET",
    path: "/admin/jobs/run",
    expectStatus: 405,
  },
];

const profileChecks =
  profile === "demo"
    ? [
        {
          name: "judge demo entry is enabled",
          path: "/demo",
          expectStatus: 200,
          expectBody: /Demo sign-in/i,
        },
        {
          name: "seeded event renders from D1",
          path: "/e/frontier-ai-summit-2026",
          expectStatus: 200,
          expectBody: /Frontier AI Summit 2026/i,
        },
        {
          name: "seeded schedule contains a published session",
          path: "/e/frontier-ai-summit-2026/schedule",
          expectStatus: 200,
          expectBody: /Building LLM Infrastructure That Scales/i,
        },
        {
          name: "anonymous schedule embed renders and permits framing",
          path: "/embed/frontier-ai-summit-2026/schedule",
          expectStatus: 200,
          expectBody: /Building LLM Infrastructure That Scales/i,
          expectHeaders: {
            "content-security-policy": /frame-ancestors \*/,
          },
          expectNoHeaders: ["x-frame-options"],
        },
        {
          name: "anonymous speakers embed renders and permits framing",
          path: "/embed/frontier-ai-summit-2026/speakers",
          expectStatus: 200,
          expectBody: /data-embed-speaker/i,
          expectHeaders: {
            "content-security-policy": /frame-ancestors \*/,
          },
          expectNoHeaders: ["x-frame-options"],
        },
      ]
    : [
        {
          name: "demo backdoor is disabled",
          path: "/demo",
          expectStatus: 404,
        },
      ];

const checks = [...commonChecks, ...profileChecks];
let failed = 0;

for (const check of checks) {
  const target = `${url}${check.path}`;
  try {
    const response = await fetch(target, { redirect: "manual" });

    if (check.expectRedirectTo) {
      const location = response.headers.get("location") ?? "";
      if (response.status < 300 || response.status >= 400 || !check.expectRedirectTo.test(location)) {
        console.error(
          `FAIL ${check.name}: got ${response.status} -> "${location}", expected a redirect matching ${check.expectRedirectTo}`,
        );
        failed += 1;
        continue;
      }
    } else if (response.status !== check.expectStatus) {
      console.error(`FAIL ${check.name}: got ${response.status}, expected ${check.expectStatus}`);
      failed += 1;
      continue;
    }

    let headerFailed = false;
    for (const [header, expected] of Object.entries(check.expectHeaders ?? {})) {
      const actual = response.headers.get(header) ?? "";
      if (!expected.test(actual)) {
        console.error(
          `FAIL ${check.name}: header ${header} was "${actual}", expected ${expected}`,
        );
        failed += 1;
        headerFailed = true;
      }
    }
    if (headerFailed) continue;

    for (const header of check.expectNoHeaders ?? []) {
      if (response.headers.has(header)) {
        console.error(
          `FAIL ${check.name}: header ${header} was present with value "${response.headers.get(header)}"`,
        );
        failed += 1;
        headerFailed = true;
      }
    }
    if (headerFailed) continue;

    if (check.expectBody) {
      const body = await response.text();
      if (!check.expectBody.test(body)) {
        console.error(`FAIL ${check.name}: body did not match ${check.expectBody}`);
        failed += 1;
        continue;
      }
    }

    console.log(`ok   ${check.name}`);
  } catch (error) {
    console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

console.log("");
if (failed > 0) {
  console.error(
    `smoke (${profile}): ${failed}/${checks.length} checks failed against ${url}`,
  );
  process.exit(1);
}
console.log(`smoke (${profile}): ${checks.length}/${checks.length} checks passed against ${url}`);
