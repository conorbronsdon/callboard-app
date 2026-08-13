import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { inspectIsolatedDemoConfig, parseJsoncConfig } from "./demo-lifecycle-lib.mjs";
import {
  reactRouterInvocation,
  runCheckedSubprocess,
  wranglerInvocation,
} from "./portable-subprocess.mjs";

function configArgument(argv) {
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let candidate;
    if (argument === "--config") {
      candidate = argv[index + 1];
      index += 1;
      if (!candidate || candidate.startsWith("--")) {
        throw new Error("demo:deploy requires a value after --config.");
      }
    } else if (argument.startsWith("--config=")) {
      candidate = argument.slice("--config=".length);
      if (!candidate) throw new Error("demo:deploy requires a non-empty --config value.");
    } else {
      throw new Error(`demo:deploy refuses unexpected argument "${argument}".`);
    }

    if (value !== undefined) {
      throw new Error("demo:deploy accepts exactly one --config argument.");
    }
    value = candidate;
  }

  if (value === undefined) {
    throw new Error(
      "demo:deploy requires --config=wrangler.demo.jsonc; the default config is never implicit.",
    );
  }
  return value;
}

const FORBIDDEN_BUILD_ENV = [
  "CALLBOARD_WRANGLER_CONFIG",
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
  "DEPLOYMENT_PROFILE",
  "DEMO_MODE",
  "DEMO_EXPIRES_AT",
  "MAIL_DRIVER",
  "APP_URL",
];

function assertCleanBuildEnvironment(environment) {
  const inherited = FORBIDDEN_BUILD_ENV.filter((name) => environment[name] !== undefined);
  if (inherited.length) {
    throw new Error(
      `demo:deploy refuses inherited deployment selection: ${inherited.join(", ")}.`,
    );
  }
}

function isWithin(path, parent) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function lstatGenerated(fileSystem, path, label, kind = "file") {
  let stat;
  try {
    stat = fileSystem.lstatSync(path);
  } catch {
    throw new Error(`The Vite build did not produce ${label}. Refusing to deploy.`);
  }
  const correctKind = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!correctKind || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular ${kind}, not a symlink. Refusing to deploy.`);
  }
  if (fileSystem.realpathSync(path) !== path) {
    throw new Error(`${label} must resolve to its expected repository path. Refusing to deploy.`);
  }
  return stat;
}

export function prepareDemoDeployment({
  argv,
  root,
  now = Date.now(),
  fileSystem = { lstatSync, readFileSync, realpathSync },
}) {
  const rootPath = fileSystem.realpathSync(resolve(root));
  const expectedPath = resolve(rootPath, "wrangler.demo.jsonc");
  const requestedPath = resolve(rootPath, configArgument(argv));

  if (requestedPath !== expectedPath) {
    throw new Error(
      "demo:deploy accepts only the gitignored repository-root wrangler.demo.jsonc.",
    );
  }

  const stat = fileSystem.lstatSync(requestedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("wrangler.demo.jsonc must be a regular file, not a symlink.");
  }
  if (fileSystem.realpathSync(requestedPath) !== expectedPath) {
    throw new Error("wrangler.demo.jsonc must resolve directly inside the repository root.");
  }

  const defaultPath = resolve(rootPath, "wrangler.jsonc");
  const defaultStat = fileSystem.lstatSync(defaultPath);
  if (!defaultStat.isFile() || defaultStat.isSymbolicLink()) {
    throw new Error("The repository-root wrangler.jsonc must be a regular file for overlap checks.");
  }

  const config = inspectIsolatedDemoConfig({
    configPath: requestedPath,
    source: fileSystem.readFileSync(requestedPath, "utf8"),
    defaultSource: fileSystem.readFileSync(defaultPath, "utf8"),
    now,
  });
  const { parsed: sourceConfig } = parseJsoncConfig(
    fileSystem.readFileSync(requestedPath, "utf8"),
    requestedPath,
  );
  if (sourceConfig.main !== "./workers/app.ts") {
    throw new Error('wrangler.demo.jsonc main must be exactly "./workers/app.ts".');
  }

  /*
   * Two child processes, in this order, and never one without the other:
   *
   *   1. build with wrangler.demo.jsonc as the resolved Wrangler config;
   *   2. deploy the config the build emitted.
   *
   * Deploying wrangler.demo.jsonc directly is what failed: an explicit --config
   * suppresses the Cloudflare Vite plugin's redirected-config handoff, so
   * Wrangler bundles ./workers/app.ts from source and cannot resolve `~/*` or
   * `virtual:react-router/server-build`. See vite.config.ts.
   */
  const buildDirectory = resolve(rootPath, "build");
  const builtConfigPath = resolve(buildDirectory, "server", "wrangler.json");
  const deployRedirectPath = resolve(rootPath, ".wrangler", "deploy", "config.json");

  return {
    config,
    sourceConfig,
    configPath: expectedPath,
    defaultConfigPath: defaultPath,
    buildDirectory,
    builtConfigPath,
    deployRedirectPath,
    build: reactRouterInvocation(rootPath, ["build"]),
    deploy: wranglerInvocation(rootPath, ["deploy", "--config", builtConfigPath]),
    cwd: rootPath,
  };
}

/**
 * The built config — not the template it came from — is what Wrangler uploads,
 * so the isolation guarantee has to be re-proved against it. A demo build that
 * silently resolved the default config, or inherited a stray DEPLOYMENT_PROFILE
 * from the operator's shell, fails here instead of reaching Cloudflare.
 */
export function assertBuiltDemoConfig({
  builtSource,
  config,
  sourceConfig,
  sourceConfigPath,
  defaultSource,
}) {
  const { parsed: built } = parseJsoncConfig(builtSource);
  const { parsed: defaults } = parseJsoncConfig(defaultSource);

  const builtD1 = Array.isArray(built.d1_databases) ? built.d1_databases : [];
  const builtR2 = Array.isArray(built.r2_buckets) ? built.r2_buckets : [];
  const vars = built.vars ?? {};

  const mismatches = [];
  const expectedD1 = sourceConfig.d1_databases?.[0];
  const expectedR2 = sourceConfig.r2_buckets?.[0];
  const expectedVars = sourceConfig.vars ?? {};
  if (built.name !== config.workerName) mismatches.push("Worker name");
  if (built.main !== "index.js") mismatches.push("generated main");
  if (built.configPath !== sourceConfigPath || built.userConfigPath !== sourceConfigPath) {
    mismatches.push("source config path");
  }
  if (built.topLevelName !== config.workerName) mismatches.push("top-level Worker name");
  if (Array.isArray(built.definedEnvironments) && built.definedEnvironments.length) {
    mismatches.push("environment selection");
  }
  if (
    builtD1.length !== 1 ||
    builtD1[0]?.binding !== "DB" ||
    builtD1[0]?.database_name !== expectedD1?.database_name ||
    builtD1[0]?.database_id !== expectedD1?.database_id
  ) {
    mismatches.push("D1 binding");
  }
  if (
    builtR2.length !== 1 ||
    builtR2[0]?.binding !== "FILES" ||
    builtR2[0]?.bucket_name !== expectedR2?.bucket_name
  ) {
    mismatches.push("R2 binding");
  }
  if (vars.DEPLOYMENT_PROFILE !== "demo") mismatches.push("DEPLOYMENT_PROFILE");
  if (String(vars.DEMO_MODE) !== "1") mismatches.push("DEMO_MODE");
  if (vars.MAIL_DRIVER !== "console") mismatches.push("MAIL_DRIVER");
  if (vars.APP_URL !== config.appUrl) mismatches.push("APP_URL");
  if (vars.DEMO_EXPIRES_AT !== expectedVars.DEMO_EXPIRES_AT) {
    mismatches.push("DEMO_EXPIRES_AT");
  }
  if (JSON.stringify(built.triggers?.crons ?? []) !== JSON.stringify(sourceConfig.triggers?.crons ?? [])) {
    mismatches.push("cron triggers");
  }
  if (built.assets?.directory !== "../client") mismatches.push("static assets directory");
  if (built.env !== undefined) mismatches.push("environment block");
  if (mismatches.length) {
    throw new Error(
      `The built Worker config does not match the disposable demo (${mismatches.join(", ")}). Refusing to deploy.`,
    );
  }

  const defaultD1 = Array.isArray(defaults.d1_databases) ? defaults.d1_databases : [];
  const defaultR2 = Array.isArray(defaults.r2_buckets) ? defaults.r2_buckets : [];
  const overlaps =
    built.name === defaults.name ||
    vars.APP_URL === defaults.vars?.APP_URL ||
    builtD1.some((binding) =>
      defaultD1.some(
        (other) =>
          other?.database_id === binding?.database_id ||
          other?.database_name === binding?.database_name,
      ),
    ) ||
    builtR2.some((binding) =>
      defaultR2.some((other) => other?.bucket_name === binding?.bucket_name),
    );
  if (overlaps) {
    throw new Error(
      "The built Worker config carries default deployment identity. Refusing to deploy.",
    );
  }

  return built;
}

export function assertGeneratedDemoDeployment({ plan, fileSystem }) {
  lstatGenerated(fileSystem, plan.deployRedirectPath, "the generated deploy redirect");
  const { parsed: redirect } = parseJsoncConfig(
    fileSystem.readFileSync(plan.deployRedirectPath, "utf8"),
    plan.deployRedirectPath,
  );
  if (
    typeof redirect.configPath !== "string" ||
    resolve(dirname(plan.deployRedirectPath), redirect.configPath) !== plan.builtConfigPath
  ) {
    throw new Error(
      "The generated deploy redirect does not target the expected built config. Refusing to deploy.",
    );
  }

  lstatGenerated(fileSystem, plan.builtConfigPath, "the generated Worker config");
  const built = assertBuiltDemoConfig({
    builtSource: fileSystem.readFileSync(plan.builtConfigPath, "utf8"),
    config: plan.config,
    sourceConfig: plan.sourceConfig,
    sourceConfigPath: plan.configPath,
    defaultSource: fileSystem.readFileSync(plan.defaultConfigPath, "utf8"),
  });

  const serverDirectory = resolve(plan.buildDirectory, "server");
  const mainPath = resolve(dirname(plan.builtConfigPath), built.main);
  if (!isWithin(mainPath, serverDirectory)) {
    throw new Error("The generated Worker main escapes build/server. Refusing to deploy.");
  }
  lstatGenerated(fileSystem, mainPath, "the generated Worker main");

  const assetsPath = resolve(dirname(plan.builtConfigPath), built.assets.directory);
  const expectedAssetsPath = resolve(plan.buildDirectory, "client");
  if (assetsPath !== expectedAssetsPath || !isWithin(assetsPath, plan.buildDirectory)) {
    throw new Error("The generated static assets path is not build/client. Refusing to deploy.");
  }
  lstatGenerated(fileSystem, assetsPath, "the generated static assets", "directory");
  return built;
}

function buildAndValidateDemo({
  argv,
  root,
  now,
  fileSystem,
  spawn,
  removeOutput,
  environment,
}) {
  const plan = prepareDemoDeployment({ argv, root, now, fileSystem });
  assertCleanBuildEnvironment(environment);

  // Neither a previous Worker bundle nor a previous Wrangler redirect may be
  // accepted as output from this build.
  removeOutput(plan.buildDirectory);
  removeOutput(plan.deployRedirectPath);

  runCheckedSubprocess({
    command: plan.build.command,
    args: plan.build.args,
    cwd: plan.cwd,
    env: {
      ...environment,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: plan.configPath,
    },
    spawn,
  });

  assertGeneratedDemoDeployment({ plan, fileSystem });
  return plan;
}

export function runDemoDeployment({
  argv,
  root,
  now = Date.now(),
  fileSystem = { lstatSync, readFileSync, realpathSync },
  spawn,
  removeOutput = (path) => rmSync(path, { recursive: true, force: true }),
  environment = process.env,
}) {
  const plan = buildAndValidateDemo({
    argv,
    root,
    now,
    fileSystem,
    spawn,
    removeOutput,
    environment,
  });

  runCheckedSubprocess({
    command: plan.deploy.command,
    args: plan.deploy.args,
    cwd: plan.cwd,
    spawn,
  });
  return plan;
}

/** Runs the exact guarded build/validation path without constructing an upload. */
export function runDemoBuildCheck(options) {
  return buildAndValidateDemo({
    now: Date.now(),
    fileSystem: { lstatSync, readFileSync, realpathSync },
    spawn: undefined,
    removeOutput: (path) => rmSync(path, { recursive: true, force: true }),
    environment: process.env,
    ...options,
  });
}
