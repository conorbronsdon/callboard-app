#!/usr/bin/env node
/**
 * Run the complete local release gate three times from independent detached
 * worktrees at one exact commit. This creates repository evidence only: it
 * never deploys, runs remote migrations, tags, or exercises a remote URL.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ATTEMPTS = 3;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CONSOLE_MAIL_MARKER = "callboard: dev email";
const FORBIDDEN_MAIL_MARKERS = ["api.resend.com", "resend: http"];

export function validateCandidateSha(value) {
  const sha = String(value ?? "").trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("Candidate must be an exact lowercase 40-character Git SHA.");
  }
  return sha;
}

export function inspectMailEvidence(output) {
  const normalized = output.toLowerCase();
  return {
    consoleMessagesObserved: normalized.split(CONSOLE_MAIL_MARKER).length - 1,
    forbiddenMarkers: FORBIDDEN_MAIL_MARKERS.filter((marker) => normalized.includes(marker)),
  };
}

export function assertCleanStatus(status, phase) {
  if (status.trim()) throw new Error(`Checkout is dirty ${phase}:\n${status}`);
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        if (options.logFile) appendFileSync(options.logFile, text);
        (stream === child.stdout ? process.stdout : process.stderr).write(text);
      });
    }
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(
        Object.assign(
          new Error(`${command} ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code ?? 1}`})`),
          { output },
        ),
      );
    });
  });
}

async function git(args, cwd = root) {
  return (await runCapture("git", args, { cwd })).trim();
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function safeEnvironment(candidateSha) {
  const env = {
    ...process.env,
    CI: "true",
    MAIL_DRIVER: "console",
    CALLBOARD_RELEASE_SHA: candidateSha,
    WRANGLER_SEND_METRICS: "false",
  };

  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) delete env[key];
  }

  // A clean release gate must not be able to contact configured providers or
  // Cloudflare even when the operator's shell happens to contain credentials.
  for (const key of [
    "RESEND_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "AIRTABLE_PAT",
  ]) {
    delete env[key];
  }
  delete env.CALLBOARD_E2E_URL;
  return env;
}

export function findLocalSecretFiles(names) {
  return names.filter(
    (name) =>
      name === ".env" ||
      name === ".dev.vars" ||
      (name.startsWith(".dev.vars.") && name !== ".dev.vars.example"),
  );
}

function assertNoLocalSecrets(checkout) {
  const files = findLocalSecretFiles(readdirSync(checkout));
  if (files.length) {
    throw new Error(`Refusing checkout containing local secret files: ${files.join(", ")}`);
  }
}

async function runAttempt(candidateSha, attempt, evidenceDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), `callboard-release-${attempt}-`));
  const checkout = join(tempRoot, "checkout");
  const logFile = join(evidenceDir, `attempt-${attempt}.log`);
  const startedAt = new Date().toISOString();
  let worktreeAdded = false;

  try {
    await git(["worktree", "add", "--detach", checkout, candidateSha]);
    worktreeAdded = true;
    const actualSha = await git(["rev-parse", "HEAD"], checkout);
    if (actualSha !== candidateSha) {
      throw new Error(`Attempt ${attempt} resolved ${actualSha}, expected ${candidateSha}.`);
    }

    assertNoLocalSecrets(checkout);
    assertCleanStatus(await git(["status", "--porcelain"], checkout), "before npm ci");

    const env = safeEnvironment(candidateSha);
    await runCapture("npm", ["ci"], { cwd: checkout, env, logFile });
    assertCleanStatus(await git(["status", "--porcelain"], checkout), "after npm ci");

    const output = await runCapture("npm", ["run", "release:verify"], {
      cwd: checkout,
      env,
      logFile,
    });
    assertCleanStatus(await git(["status", "--porcelain"], checkout), "after release:verify");

    const mail = inspectMailEvidence(output);
    if (mail.forbiddenMarkers.length) {
      throw new Error(`Provider-mail indicators detected: ${mail.forbiddenMarkers.join(", ")}`);
    }
    if (mail.consoleMessagesObserved < 1) {
      throw new Error(
        "No ConsoleMailer output was observed; this attempt cannot prove that an exercised mail path stayed local.",
      );
    }

    return {
      attempt,
      candidateSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: "passed",
      checkoutCleanBeforeAndAfter: true,
      dependencyInstall: "npm ci",
      command: "npm run release:verify",
      isolatedCheckout: true,
      isolatedE2ePersistence: true,
      mail: {
        driver: "console",
        providerCredentialPresent: false,
        ...mail,
      },
      log: `attempt-${attempt}.log`,
    };
  } catch (error) {
    return {
      attempt,
      candidateSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: "failed",
      error: error instanceof Error ? error.message : String(error),
      log: `attempt-${attempt}.log`,
    };
  } finally {
    if (worktreeAdded) {
      try {
        await git(["worktree", "remove", "--force", checkout]);
      } catch (error) {
        console.error(`[release-gate] failed to remove worktree: ${error}`);
      }
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    try {
      await git(["worktree", "prune"]);
    } catch (error) {
      console.error(`[release-gate] failed to prune worktrees: ${error}`);
    }
  }
}

export function selfTest() {
  const valid = "a".repeat(40);
  if (validateCandidateSha(valid) !== valid) throw new Error("valid SHA was rejected");
  for (const invalid of ["abc", "A".repeat(40), `${valid}/../main`]) {
    let rejected = false;
    try {
      validateCandidateSha(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`unsafe SHA was accepted: ${invalid}`);
  }

  assertCleanStatus("", "during self-test");
  let dirtyRejected = false;
  try {
    assertCleanStatus(" M package.json", "during self-test");
  } catch {
    dirtyRejected = true;
  }
  if (!dirtyRejected) throw new Error("dirty checkout was accepted");

  const safe = inspectMailEvidence("callboard: dev email");
  if (safe.consoleMessagesObserved !== 1 || safe.forbiddenMarkers.length) {
    throw new Error("console-mail positive control failed");
  }
  const unsafe = inspectMailEvidence("resend: HTTP 403 from https://api.resend.com");
  if (unsafe.forbiddenMarkers.length !== 2) {
    throw new Error("provider-mail negative control failed");
  }
  const secretFiles = findLocalSecretFiles([
    ".dev.vars.example",
    ".env.example",
    ".dev.vars",
    ".dev.vars.demo",
    ".env",
  ]);
  if (
    secretFiles.join(",") !== [".dev.vars", ".dev.vars.demo", ".env"].join(",")
  ) {
    throw new Error(`local-secret allow/deny controls failed: ${secretFiles.join(", ")}`);
  }
  console.log("repeat release gate: self-tests passed");
}

export async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const candidateSha = validateCandidateSha(process.env.CALLBOARD_RELEASE_SHA);
  const sourceSha = await git(["rev-parse", "HEAD"]);
  if (sourceSha !== candidateSha) {
    throw new Error(`Harness checkout is ${sourceSha}; requested candidate is ${candidateSha}.`);
  }
  assertCleanStatus(await git(["status", "--porcelain"]), "in the harness checkout");

  const evidenceArg = process.argv.find((arg) => arg.startsWith("--evidence-dir="));
  const evidenceDir = resolve(
    root,
    evidenceArg?.slice("--evidence-dir=".length) ?? join("artifacts", "release-gate", candidateSha),
  );
  mkdirSync(evidenceDir, { recursive: true });
  const manifestPath = join(evidenceDir, "manifest.json");
  const manifest = {
    schemaVersion: 1,
    candidateSha,
    expectedAttempts: ATTEMPTS,
    startedAt: new Date().toISOString(),
    result: "running",
    scope: "repository-only",
    doesNotCover: [
      "full-history secret scanning",
      "remote deployment or migration",
      "deployed smoke or judge walkthrough",
      "release tagging",
      "rollback or restoration rehearsal",
    ],
    attempts: [],
  };
  writeManifest(manifestPath, manifest);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    console.log(`\n[release-gate] attempt ${attempt}/${ATTEMPTS} at ${candidateSha}`);
    const result = await runAttempt(candidateSha, attempt, evidenceDir);
    manifest.attempts.push(result);
    writeManifest(manifestPath, manifest);
    if (result.result !== "passed") {
      manifest.result = "failed";
      manifest.finishedAt = new Date().toISOString();
      writeManifest(manifestPath, manifest);
      throw new Error(`Release gate stopped after failed attempt ${attempt}: ${result.error}`);
    }
  }

  manifest.result = "passed";
  manifest.finishedAt = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  console.log(`[release-gate] three consecutive isolated attempts passed: ${manifestPath}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release-gate] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
