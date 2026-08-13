import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  executePlan,
  inspectIsolatedDemoConfig,
  resetPlan,
} from "./demo-lifecycle-lib.mjs";
import { runCheckedSubprocess, runWrangler, wranglerInvocation } from "./portable-subprocess.mjs";

export function prepareDemoReset({
  argv,
  root,
  now = Date.now(),
  fileSystem = { readFileSync },
}) {
  const execute = argv.includes("--execute");
  const configArgument = argv.find((argument) => argument.startsWith("--config="));
  const configPath = resolve(
    root,
    configArgument?.slice("--config=".length) ?? "wrangler.demo.jsonc",
  );
  const source = fileSystem.readFileSync(configPath, "utf8");
  const defaultSource = fileSystem.readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
  const config = inspectIsolatedDemoConfig({ configPath, source, defaultSource, now });

  return { config, configPath, execute, root: resolve(root) };
}

function absoluteConfigArgs(args, configPath) {
  return args.map((arg) => (arg === "wrangler.demo.jsonc" ? configPath : arg));
}

export function runDemoReset({
  argv,
  root,
  now = Date.now(),
  fileSystem,
  spawn,
  log = console.log,
}) {
  const prepared = prepareDemoReset({ argv, root, now, fileSystem });
  const { config, configPath, execute } = prepared;
  const initialPlan = resetPlan({
    databaseName: config.databaseName,
    bucketName: config.bucketName,
  });

  let uploadKeys = [];
  if (execute) {
    const migration = initialPlan[0];
    runWrangler({
      root: prepared.root,
      args: absoluteConfigArgs(migration.args, configPath),
      spawn,
    });
    const output = runWrangler({
      root: prepared.root,
      args: [
        "d1",
        "execute",
        config.databaseName,
        "--remote",
        "--config",
        configPath,
        "--command",
        "SELECT key FROM uploads ORDER BY key;",
        "--json",
      ],
      capture: true,
      spawn,
    });
    const parsed = JSON.parse(output);
    const rows = parsed.flatMap((entry) => entry.results ?? []);
    uploadKeys = rows.map((row) => row.key).filter((key) => typeof key === "string");
  }

  const plan = resetPlan({
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    uploadKeys,
  }).map((step) => ({
    ...step,
    args: absoluteConfigArgs(step.args, configPath),
  }));

  log(
    `Disposable demo reset for ${config.workerName}; expires ${new Date(config.expiresAt).toISOString()}.`,
  );
  for (const step of plan) {
    if (step.command === "wrangler") {
      const invocation = wranglerInvocation(prepared.root, step.args);
      log(`- ${step.label}: ${invocation.command} ${invocation.args.join(" ")}`);
    } else {
      log(`- ${step.label}: ${step.command} ${step.args.join(" ")}`);
    }
  }

  if (!execute) {
    log("Dry run only. Re-run with --execute after reviewing the exact targets.");
    return { ...prepared, plan };
  }

  executePlan(plan.slice(1), (step) => {
    if (step.command === "wrangler") {
      runWrangler({ root: prepared.root, args: step.args, spawn });
      return;
    }
    runCheckedSubprocess({
      command: step.command,
      args: step.args,
      cwd: prepared.root,
      spawn,
    });
  });
  log("Disposable demo reset completed. Run npm run smoke:demo against its origin.");
  return { ...prepared, plan };
}
