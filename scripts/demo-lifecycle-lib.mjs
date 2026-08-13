import { basename } from "node:path";

const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DISPOSABLE_PREFIX = "callboard-disposable-demo";
const SAFETY_CRITICAL_KEYS = [
  "name",
  "APP_URL",
  "DEPLOYMENT_PROFILE",
  "DEMO_MODE",
  "MAIL_DRIVER",
  "DEMO_EXPIRES_AT",
  "d1_databases",
  "database_name",
  "database_id",
  "r2_buckets",
  "bucket_name",
];

function stripJsoncComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        index += 1;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }

  if (blockComment) throw new Error("Demo config contains an unterminated block comment.");
  if (inString) throw new Error("Demo config contains an unterminated string.");
  return output;
}

function removeTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") {
        output += " ";
        continue;
      }
    }
    output += char;
  }

  return output;
}

function countKey(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`"${escaped}"\\s*:`, "g"))].length;
}

function rejectEscapedPropertyNames(source) {
  let inString = false;
  let escaped = false;
  let propertyNameHasEscape = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!inString) {
      if (char === '"') {
        inString = true;
        propertyNameHasEscape = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      propertyNameHasEscape = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;

    inString = false;
    let lookahead = index + 1;
    while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
    if (source[lookahead] === ":" && propertyNameHasEscape) {
      throw new Error(
        "Demo config refuses escaped property names because they can hide duplicate safety keys.",
      );
    }
  }
}

export function parseJsoncConfig(source) {
  const uncommented = stripJsoncComments(source);
  rejectEscapedPropertyNames(uncommented);
  for (const key of SAFETY_CRITICAL_KEYS) {
    const count = countKey(uncommented, key);
    if (count > 1) {
      throw new Error(`Demo config must define safety-critical key "${key}" at most once.`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(removeTrailingCommas(uncommented));
  } catch (error) {
    throw new Error(
      `Demo config is not valid JSONC: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Demo config must contain one top-level object.");
  }
  return { parsed, uncommented };
}

function oneBinding(value, label) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new Error(`Demo config must define exactly one ${label} binding.`);
  }
  return value[0];
}

export function inspectDemoConfig({
  configPath,
  source,
  now = Date.now(),
}) {
  if (basename(configPath) !== "wrangler.demo.jsonc") {
    throw new Error("Lifecycle operations require the gitignored wrangler.demo.jsonc file.");
  }

  const { parsed, uncommented } = parseJsoncConfig(source);
  if (/REPLACE_[A-Z0-9_]+/.test(uncommented)) {
    throw new Error("Replace every REPLACE_* placeholder before operating a demo.");
  }

  const vars = parsed.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    throw new Error("Demo config must define a vars object.");
  }
  const d1 = oneBinding(parsed.d1_databases, "D1");
  const r2 = oneBinding(parsed.r2_buckets, "R2");
  if (d1.binding !== "DB" || r2.binding !== "FILES") {
    throw new Error('Disposable demo bindings must be named "DB" and "FILES".');
  }

  const workerName = parsed.name;
  const deploymentProfile = vars.DEPLOYMENT_PROFILE;
  const demoMode = vars.DEMO_MODE;
  const mailDriver = vars.MAIL_DRIVER;
  const expiryRaw = vars.DEMO_EXPIRES_AT;
  const databaseName = d1.database_name;
  const databaseId = d1.database_id;
  const bucketName = r2.bucket_name;
  const appUrl = vars.APP_URL;

  if (
    typeof workerName !== "string" ||
    typeof databaseName !== "string" ||
    typeof bucketName !== "string" ||
    !workerName.startsWith(DISPOSABLE_PREFIX) ||
    !databaseName.startsWith(DISPOSABLE_PREFIX) ||
    !bucketName.startsWith(DISPOSABLE_PREFIX)
  ) {
    throw new Error(
      `Worker, D1, and R2 names must all start with "${DISPOSABLE_PREFIX}".`,
    );
  }
  if (
    deploymentProfile !== "demo" ||
    typeof demoMode !== "string" ||
    !["1", "true"].includes(demoMode.toLowerCase())
  ) {
    throw new Error("The disposable config must explicitly set demo profile and mode.");
  }
  if (mailDriver !== "console") {
    throw new Error("Disposable demos must pin MAIL_DRIVER to console.");
  }

  const expiresAt = Date.parse(typeof expiryRaw === "string" ? expiryRaw : "");
  if (!Number.isFinite(expiresAt)) {
    throw new Error("DEMO_EXPIRES_AT must be a valid ISO-8601 timestamp.");
  }
  if (expiresAt <= now) {
    throw new Error("DEMO_EXPIRES_AT has passed; do not reset or redeploy an expired demo.");
  }
  if (expiresAt - now > MAX_LIFETIME_MS) {
    throw new Error("Disposable demo expiry must be within seven days.");
  }

  return {
    workerName,
    databaseName,
    databaseId,
    bucketName,
    appUrl,
    expiresAt,
  };
}

function exactHttpsOrigin(appUrl, label) {
  if (typeof appUrl !== "string" || appUrl.length === 0) {
    throw new Error(`${label} APP_URL is required.`);
  }

  let parsed;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error(`${label} APP_URL must be a valid absolute HTTPS origin.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    appUrl.replace(/\/$/, "") !== parsed.origin
  ) {
    throw new Error(
      `${label} APP_URL must be an exact HTTPS origin with no credentials, path, query, or fragment.`,
    );
  }
  return parsed.origin;
}

export function inspectIsolatedDemoConfig({
  configPath,
  source,
  defaultSource,
  now = Date.now(),
}) {
  const config = inspectDemoConfig({ configPath, source, now });
  if (typeof config.databaseId !== "string" || config.databaseId.length === 0) {
    throw new Error("Disposable demo D1 database_id is required.");
  }
  const appOrigin = exactHttpsOrigin(config.appUrl, "Disposable demo");
  const { parsed: defaultConfig } = parseJsoncConfig(defaultSource);
  const defaultD1 = Array.isArray(defaultConfig.d1_databases)
    ? defaultConfig.d1_databases
    : [];
  const defaultR2 = Array.isArray(defaultConfig.r2_buckets)
    ? defaultConfig.r2_buckets
    : [];
  const defaultOrigin = exactHttpsOrigin(defaultConfig.vars?.APP_URL, "Default deployment");

  const overlapsDefault =
    config.workerName === defaultConfig.name ||
    appOrigin === defaultOrigin ||
    defaultD1.some(
      (binding) =>
        binding?.database_id === config.databaseId ||
        binding?.database_name === config.databaseName,
    ) ||
    defaultR2.some((binding) => binding?.bucket_name === config.bucketName);
  if (overlapsDefault) {
    throw new Error(
      "Disposable demo Worker, APP_URL, D1, and R2 identities must not overlap the default deployment.",
    );
  }

  return { ...config, appOrigin };
}

export function resetPlan({ databaseName, bucketName, uploadKeys = [] }) {
  const configArgs = ["--config", "wrangler.demo.jsonc"];
  return [
    {
      label: "apply migrations",
      command: "wrangler",
      args: [
        "d1",
        "migrations",
        "apply",
        databaseName,
        "--remote",
        ...configArgs,
      ],
    },
    ...uploadKeys.map((key) => ({
      label: `delete R2 object ${key}`,
      command: "wrangler",
      args: [
        "r2",
        "object",
        "delete",
        `${bucketName}/${key}`,
        "--remote",
        ...configArgs,
      ],
    })),
    {
      label: "wipe mutable D1 state",
      command: "wrangler",
      args: [
        "d1",
        "execute",
        databaseName,
        "--remote",
        ...configArgs,
        "--command",
        "PRAGMA foreign_keys = ON; DELETE FROM events; DELETE FROM people; DELETE FROM rate_limit_windows;",
      ],
    },
    {
      label: "restore deterministic seed",
      command: "node",
      args: [
        "scripts/seed.mjs",
        "--remote",
        `--database=${databaseName}`,
        "--config=wrangler.demo.jsonc",
      ],
    },
  ];
}

export function executePlan(steps, execute) {
  for (const step of steps) execute(step);
}

export function demoExpired(expiresAt, now = Date.now()) {
  const timestamp = Date.parse(expiresAt ?? "");
  return !Number.isFinite(timestamp) || timestamp <= now;
}
