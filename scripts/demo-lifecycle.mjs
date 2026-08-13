#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDemoReset } from "./demo-lifecycle-runner.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  runDemoReset({ argv: process.argv.slice(2), root });
} catch (error) {
  console.error(`demo:reset: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
