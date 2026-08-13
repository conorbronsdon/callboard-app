import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeEnvironment } from "./repeat-release-verify.mjs";

const SHA = "b".repeat(40);
let originalEnvironment;

beforeEach(() => {
  originalEnvironment = process.env;
  process.env = {
    ...originalEnvironment,
    npm_config_allow_scripts: "true",
    npm_config_something_else: "x",
    npm_config_registry: "https://registry.npmjs.org/",
    PATH: "/usr/bin",
    HOME: "/home/x",
    CALLBOARD_RELEASE_SHA: "a".repeat(40),
    CALLBOARD_RELEASE_SHA_UNRELATED: "keep-me",
  };
});

afterEach(() => {
  process.env = originalEnvironment;
});

describe("safeEnvironment", () => {
  it("strips inherited npm configuration without stripping unrelated environment", () => {
    const result = safeEnvironment(SHA);

    expect(Object.keys(result).filter((key) => /^npm_config_/i.test(key))).toEqual([]);
    expect(result).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/x",
      CALLBOARD_RELEASE_SHA: SHA,
      CALLBOARD_RELEASE_SHA_UNRELATED: "keep-me",
    });
  });
});
