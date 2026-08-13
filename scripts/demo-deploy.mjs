#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDemoDeployment } from "./demo-deploy-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  const plan = runDemoDeployment({ argv: process.argv.slice(2), root });
  console.log(
    `Disposable demo deployment completed for ${plan.config.workerName} at ${plan.config.appOrigin}.`,
  );
  console.log(`Run npm run smoke:demo -- ${plan.config.appOrigin}`);
} catch (error) {
  console.error(`demo:deploy: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
