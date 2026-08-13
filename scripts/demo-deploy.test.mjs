import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectDemoConfig, parseJsoncConfig } from "./demo-lifecycle-lib.mjs";
import {
  assertBuiltDemoConfig,
  prepareDemoDeployment,
  runDemoDeployment,
} from "./demo-deploy-lib.mjs";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const safeConfig = `
{
  // Comments and trailing commas are valid Wrangler JSONC.
  "name": "callboard-disposable-demo-judges",
  "main": "./workers/app.ts",
  "vars": {
    "APP_URL": "https://callboard-disposable-demo-judges.example.test",
    "DEPLOYMENT_PROFILE": "demo",
    "DEMO_MODE": "1",
    "MAIL_DRIVER": "console",
    "DEMO_EXPIRES_AT": "2026-08-11T12:00:00.000Z",
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "callboard-disposable-demo-db",
    "database_id": "disposable-database-id",
  }],
  "r2_buckets": [{
    "binding": "FILES",
    "bucket_name": "callboard-disposable-demo-files",
  }],
  "triggers": { "crons": [] },
}
`;

const defaultConfig = `
{
  "name": "callboard",
  "vars": {
    "APP_URL": "https://callboard.example.test",
    "DEPLOYMENT_PROFILE": "production",
    "DEMO_MODE": "0"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "callboard-db",
    "database_id": "production-database-id"
  }],
  "r2_buckets": [{
    "binding": "FILES",
    "bucket_name": "callboard-files"
  }]
}
`;

function withDemoConfig(source, callback) {
  const root = mkdtempSync(join(tmpdir(), "callboard-demo-deploy-"));
  writeFileSync(join(root, "wrangler.demo.jsonc"), source);
  writeFileSync(join(root, "wrangler.jsonc"), defaultConfig);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/*
 * What the build emits for a demo config. `matchingBuiltConfig` is the only
 * source of truth in these tests for "the thing Wrangler would actually upload".
 */
const matchingBuiltConfig = JSON.stringify({
  configPath: "CONFIG_PATH",
  userConfigPath: "CONFIG_PATH",
  topLevelName: "callboard-disposable-demo-judges",
  definedEnvironments: [],
  name: "callboard-disposable-demo-judges",
  main: "index.js",
  assets: { directory: "../client" },
  vars: {
    APP_URL: "https://callboard-disposable-demo-judges.example.test",
    DEPLOYMENT_PROFILE: "demo",
    DEMO_MODE: "1",
    MAIL_DRIVER: "console",
    DEMO_EXPIRES_AT: "2026-08-11T12:00:00.000Z",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "callboard-disposable-demo-db",
      database_id: "disposable-database-id",
    },
  ],
  r2_buckets: [{ binding: "FILES", bucket_name: "callboard-disposable-demo-files" }],
  triggers: { crons: [] },
});

/** Records every child process, and serves a chosen built config to the verifier. */
function instrumentedRun({
  root,
  builtSource = matchingBuiltConfig,
  redirectSource,
  spawnResults = [],
  environment = { EXISTING: "kept" },
  afterBuild,
  symbolicPaths = [],
}) {
  const calls = [];
  const removed = [];
  let spawnIndex = 0;
  const result = {
    calls,
    removed,
    run: () =>
      runDemoDeployment({
        argv: ["--config=wrangler.demo.jsonc"],
        root,
        now: NOW,
        removeOutput: (path) => removed.push(path),
        environment,
        fileSystem: {
          readFileSync,
          realpathSync,
          lstatSync(path) {
            const stat = lstatSync(path);
            if (!symbolicPaths.includes(path)) return stat;
            return new Proxy(stat, {
              get(target, property) {
                return property === "isSymbolicLink" ? () => true : target[property];
              },
            });
          },
        },
        spawn(command, args, options) {
          calls.push({ command, args, options });
          const outcome = spawnResults[spawnIndex] ?? { status: 0 };
          if (spawnIndex === 0 && !outcome.error && outcome.status === 0) {
            const server = join(root, "build", "server");
            mkdirSync(server, { recursive: true });
            mkdirSync(join(root, "build", "client"), { recursive: true });
            mkdirSync(join(root, ".wrangler", "deploy"), { recursive: true });
            writeFileSync(join(server, "index.js"), "export default {};\n");
            writeFileSync(
              join(server, "wrangler.json"),
              builtSource.replaceAll(
                '"CONFIG_PATH"',
                JSON.stringify(join(root, "wrangler.demo.jsonc")),
              ),
            );
            writeFileSync(
              join(root, ".wrangler", "deploy", "config.json"),
              redirectSource ?? JSON.stringify({ configPath: "../../build/server/wrangler.json" }),
            );
            afterBuild?.({
              root,
              builtConfigPath: join(server, "wrangler.json"),
              mainPath: join(server, "index.js"),
              assetsPath: join(root, "build", "client"),
              redirectPath: join(root, ".wrangler", "deploy", "config.json"),
            });
          }
          spawnIndex += 1;
          return outcome;
        },
      }),
  };
  return result;
}

describe("guarded demo deploy — must not fire", () => {
  it("plans a build with the demo config and a deploy of what that build emits", () => {
    withDemoConfig(safeConfig, (root) => {
      const plan = prepareDemoDeployment({
        argv: ["--config=wrangler.demo.jsonc"],
        root,
        now: NOW,
      });
      expect(plan.build.command).toBe(process.execPath);
      expect(plan.build.args).toEqual([
        join(root, "node_modules", "@react-router", "dev", "bin.cjs"),
        "build",
      ]);
      expect(plan.deploy.command).toBe(process.execPath);
      expect(plan.deploy.args).toEqual([
        join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
        "deploy",
        "--config",
        join(root, "build", "server", "wrangler.json"),
      ]);
      // The template is what the build reads, never what the deploy uploads.
      expect(plan.deploy.args).not.toContain(join(root, "wrangler.demo.jsonc"));
      expect(plan.config.appOrigin).toBe(
        "https://callboard-disposable-demo-judges.example.test",
      );
    });
  });

  it("wipes a stale build, then builds with the demo config, then deploys", () => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({ root });
      harness.run();

      expect(harness.removed).toEqual([
        join(root, "build"),
        join(root, ".wrangler", "deploy", "config.json"),
      ]);
      expect(harness.calls).toHaveLength(2);

      const [build, deploy] = harness.calls;
      expect(build.args[0]).toBe(
        join(root, "node_modules", "@react-router", "dev", "bin.cjs"),
      );
      expect(build.options.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH).toBe(
        join(root, "wrangler.demo.jsonc"),
      );
      expect(build.options.env.CALLBOARD_WRANGLER_CONFIG).toBeUndefined();
      expect(build.options.env.EXISTING).toBe("kept");
      expect(build.options.shell).toBe(false);

      expect(deploy.args[0]).toBe(
        join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      );
      expect(deploy.args.at(-1)).toBe(join(root, "build", "server", "wrangler.json"));
      expect(deploy.options.shell).toBe(false);
      // The deploy must not inherit the build's config override.
      expect(deploy.options.env).toBeUndefined();
    });
  });

  it("accepts a built config that matches the demo template", () => {
    expect(() =>
      assertBuiltDemoConfig({
        builtSource: matchingBuiltConfig,
        config: {
          workerName: "callboard-disposable-demo-judges",
          databaseName: "callboard-disposable-demo-db",
          databaseId: "disposable-database-id",
          bucketName: "callboard-disposable-demo-files",
          appUrl: "https://callboard-disposable-demo-judges.example.test",
        },
        sourceConfig: parseJsoncConfig(safeConfig).parsed,
        sourceConfigPath: "CONFIG_PATH",
        defaultSource: defaultConfig,
      }),
    ).not.toThrow();
  });

  it("surfaces a sanitized child-process spawn error", () => {
    withDemoConfig(safeConfig, (root) => {
      const spawnError = Object.assign(new Error("spawn node ENOENT"), {
        code: "ENOENT",
      });
      expect(() =>
        runDemoDeployment({
          argv: ["--config=wrangler.demo.jsonc"],
          root,
          now: NOW,
          environment: {},
          spawn() {
            return { error: spawnError, status: null };
          },
        }),
      ).toThrow(/spawn failed \(ENOENT: spawn node ENOENT\)/);
    });
  });
});

describe("guarded demo deploy — must fire", () => {
  it.each([
    ["an omitted config", []],
    ["the default config", ["--config=wrangler.jsonc"]],
    ["the checked-in example", ["--config=wrangler.demo.example.jsonc"]],
    ["a config outside the repository root", ["--config=../wrangler.demo.jsonc"]],
    ["extra Wrangler overrides", ["--config=wrangler.demo.jsonc", "--env", "production"]],
    ["duplicate config arguments", ["--config=wrangler.demo.jsonc", "--config=wrangler.demo.jsonc"]],
  ])("rejects %s", (_name, argv) => {
    withDemoConfig(safeConfig, (root) => {
      expect(() => prepareDemoDeployment({ argv, root, now: NOW })).toThrow();
    });
  });

  it("refuses a symlink even when it has the required filename", () => {
    withDemoConfig(safeConfig, (root) => {
      const configPath = join(root, "wrangler.demo.jsonc");
      expect(() =>
        prepareDemoDeployment({
          argv: ["--config=wrangler.demo.jsonc"],
          root,
          now: NOW,
          fileSystem: {
            lstatSync(path) {
              if (path === configPath) {
                return { isFile: () => true, isSymbolicLink: () => true };
              }
              return lstatSync(path);
            },
            readFileSync,
            realpathSync,
          },
        }),
      ).toThrow(/regular file, not a symlink/);
    });
  });

  it("does not let a safe value in a comment spoof the deployed value", () => {
    const source = safeConfig.replace(
      '"MAIL_DRIVER": "console"',
      '// "MAIL_DRIVER": "console"\n    "MAIL_DRIVER": "resend"',
    );
    expect(() =>
      inspectDemoConfig({
        configPath: "/tmp/wrangler.demo.jsonc",
        source,
        now: NOW,
      }),
    ).toThrow(/MAIL_DRIVER/);
  });

  it.each([
    [
      "safe-first / unsafe-last",
      '"MAIL_DRIVER": "console",\n    "MAIL_DRIVER": "resend"',
    ],
    [
      "unsafe-first / safe-last",
      '"MAIL_DRIVER": "resend",\n    "MAIL_DRIVER": "console"',
    ],
  ])("rejects ambiguous duplicate keys: %s", (_name, replacement) => {
    const source = safeConfig.replace('"MAIL_DRIVER": "console"', replacement);
    expect(() =>
      inspectDemoConfig({
        configPath: "/tmp/wrangler.demo.jsonc",
        source,
        now: NOW,
      }),
    ).toThrow(/at most once/);
  });

  it.each(["safe-first / escaped-unsafe-last", "escaped-unsafe-first / safe-last"])(
    "rejects Unicode-escaped effective duplicate keys: %s",
    (order) => {
      const escapedName = String.raw`"\u006eame"`;
      const normalName = '"name": "callboard-disposable-demo-judges"';
      const ambiguous =
        order.startsWith("safe-first")
          ? `${normalName},\n  ${escapedName}: "callboard-production"`
          : `${escapedName}: "callboard-production",\n  ${normalName}`;
      const source = safeConfig.replace(normalName, ambiguous);
      expect(() =>
        inspectDemoConfig({
          configPath: "/tmp/wrangler.demo.jsonc",
          source,
          now: NOW,
        }),
      ).toThrow(/escaped property names/);
    },
  );

  it.each([
    [
      "an unresolved placeholder",
      safeConfig.replace("disposable-database-id", "REPLACE_DATABASE_ID"),
    ],
    [
      "a path-bearing APP_URL",
      safeConfig.replace(
        "https://callboard-disposable-demo-judges.example.test",
        "https://callboard-disposable-demo-judges.example.test/admin",
      ),
    ],
    [
      "a demo label pointing at the default production D1 id",
      safeConfig.replace("disposable-database-id", "production-database-id"),
    ],
    [
      "the default production APP_URL under a demo worker name",
      safeConfig.replace(
        "https://callboard-disposable-demo-judges.example.test",
        "https://callboard.example.test",
      ),
    ],
    [
      "a missing D1 id",
      safeConfig.replace('"database_id": "disposable-database-id"', '"database_id": ""'),
    ],
    [
      "a renamed D1 binding",
      safeConfig.replace('"binding": "DB"', '"binding": "PRODUCTION_DB"'),
    ],
    [
      "a renamed R2 binding",
      safeConfig.replace('"binding": "FILES"', '"binding": "PRODUCTION_FILES"'),
    ],
  ])("never invokes Wrangler for %s", (_name, source) => {
    withDemoConfig(source, (root) => {
      const calls = [];
      expect(() =>
        runDemoDeployment({
          argv: ["--config=wrangler.demo.jsonc"],
          root,
          now: NOW,
          environment: {},
          spawn(...args) {
            calls.push(args);
            return { status: 0 };
          },
        }),
      ).toThrow();
      expect(calls).toEqual([]);
    });
  });

  it("never builds or deploys a source config with a generated main", () => {
    withDemoConfig(safeConfig.replace("./workers/app.ts", "./build/server/index.js"), (root) => {
      const harness = instrumentedRun({ root });
      expect(() => harness.run()).toThrow(/main must be exactly/);
      expect(harness.calls).toEqual([]);
    });
  });

  it.each([
    ["CLOUDFLARE_ENV", "production"],
    ["CALLBOARD_WRANGLER_CONFIG", "wrangler.jsonc"],
    ["CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH", "wrangler.jsonc"],
    ["DEPLOYMENT_PROFILE", "production"],
    ["DEMO_MODE", "0"],
    ["MAIL_DRIVER", "resend"],
    ["MAIL_DRIVER", "console"],
    ["APP_URL", "https://callboard.example.test"],
    ["DEMO_EXPIRES_AT", "2099-01-01T00:00:00.000Z"],
  ])("never builds or deploys with inherited %s", (name, value) => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({ root, environment: { [name]: value } });
      expect(() => harness.run()).toThrow(/inherited deployment selection/);
      expect(harness.calls).toEqual([]);
    });
  });

  it.each([
    ["a missing redirect", ({ redirectPath }) => unlinkSync(redirectPath), /deploy redirect/],
    ["a malformed redirect", ({ redirectPath }) => writeFileSync(redirectPath, "{"), /valid JSONC/],
    [
      "an out-of-root redirect",
      ({ redirectPath }) => writeFileSync(redirectPath, JSON.stringify({ configPath: "../../../outside.json" })),
      /does not target/,
    ],
    ["a missing generated config", ({ builtConfigPath }) => unlinkSync(builtConfigPath), /Worker config/],
    ["a malformed generated config", ({ builtConfigPath }) => writeFileSync(builtConfigPath, "{"), /valid JSONC/],
    ["a missing generated main", ({ mainPath }) => unlinkSync(mainPath), /Worker main/],
    ["missing generated static assets", ({ assetsPath }) => rmSync(assetsPath, { recursive: true }), /static assets/],
  ])("builds but never deploys %s", (_name, afterBuild, error) => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({ root, afterBuild });
      expect(() => harness.run()).toThrow(error);
      expect(harness.calls).toHaveLength(1);
    });
  });

  it.each([
    ["the generated redirect", (root) => join(root, ".wrangler", "deploy", "config.json")],
    ["the generated config", (root) => join(root, "build", "server", "wrangler.json")],
    ["the generated main", (root) => join(root, "build", "server", "index.js")],
    ["the static assets", (root) => join(root, "build", "client")],
  ])("builds but never deploys a symlinked %s", (_name, symbolicPath) => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({ root, symbolicPaths: [symbolicPath(root)] });
      expect(() => harness.run()).toThrow(/not a symlink/);
      expect(harness.calls).toHaveLength(1);
    });
  });

  it("never deploys when the build fails", () => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({
        root,
        spawnResults: [{ status: 1 }],
      });
      expect(() => harness.run()).toThrow(/exit code 1/);
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0].args[0]).toBe(
        join(root, "node_modules", "@react-router", "dev", "bin.cjs"),
      );
    });
  });

  it("attempts a failing deploy exactly once and never retries", () => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({
        root,
        spawnResults: [{ status: 0 }, { status: 23 }],
      });
      expect(() => harness.run()).toThrow(/exit code 23/);
      expect(harness.calls).toHaveLength(2);
    });
  });

  it.each([
    [
      "the default Worker name",
      matchingBuiltConfig.replace("callboard-disposable-demo-judges", "callboard"),
    ],
    [
      "the default D1 database",
      matchingBuiltConfig.replace("callboard-disposable-demo-db", "callboard-db"),
    ],
    [
      "the default R2 bucket",
      matchingBuiltConfig.replace("callboard-disposable-demo-files", "callboard-files"),
    ],
    [
      "the production profile",
      matchingBuiltConfig.replace('"DEPLOYMENT_PROFILE":"demo"', '"DEPLOYMENT_PROFILE":"production"'),
    ],
    ["demo mode off", matchingBuiltConfig.replace('"DEMO_MODE":"1"', '"DEMO_MODE":"0"')],
    [
      "a live mail driver",
      matchingBuiltConfig.replace('"MAIL_DRIVER":"console"', '"MAIL_DRIVER":"resend"'),
    ],
    [
      "an APP_URL the guard never approved",
      matchingBuiltConfig.replace(
        "https://callboard-disposable-demo-judges.example.test",
        "https://callboard.example.test",
      ),
    ],
    [
      "a stale source config path",
      matchingBuiltConfig.replaceAll("CONFIG_PATH", "C:/stale/wrangler.jsonc"),
    ],
    [
      "a changed expiry",
      matchingBuiltConfig.replace(
        "2026-08-11T12:00:00.000Z",
        "2026-08-12T12:00:00.000Z",
      ),
    ],
    ["a source entrypoint", matchingBuiltConfig.replace('"main":"index.js"', '"main":"../../workers/app.ts"')],
    [
      "an out-of-root assets directory",
      matchingBuiltConfig.replace('"directory":"../client"', '"directory":"../../../outside"'),
    ],
    [
      "a selected production environment",
      matchingBuiltConfig.replace('"definedEnvironments":[]', '"definedEnvironments":["production"]'),
    ],
  ])("builds but never deploys a built config carrying %s", (_name, builtSource) => {
    withDemoConfig(safeConfig, (root) => {
      const harness = instrumentedRun({ root, builtSource });
      expect(() => harness.run()).toThrow(/Refusing to deploy/);
      // The build ran; the deploy did not.
      expect(harness.calls).toHaveLength(1);
    });
  });
});
