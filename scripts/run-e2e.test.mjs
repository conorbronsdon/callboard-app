import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  E2E_STATE_PREFIX,
  assertDisposableStatePath,
  withDisposableState,
} from "./run-e2e.mjs";

describe("assertDisposableStatePath — must fire", () => {
  it("rejects the temp root itself", () => {
    expect(() => assertDisposableStatePath(tmpdir())).toThrow(/Refusing non-disposable/);
  });

  it("rejects a normal project persistence directory", () => {
    expect(() => assertDisposableStatePath(resolve(".wrangler/state"))).toThrow(
      /Refusing non-disposable/,
    );
  });

  it("rejects an unrelated directory inside the temp root", () => {
    expect(() => assertDisposableStatePath(join(tmpdir(), "other-project"))).toThrow(
      /Refusing non-disposable/,
    );
  });
});

describe("assertDisposableStatePath — must not fire", () => {
  it("accepts the exact shape created by the E2E runner", () => {
    const directory = mkdtempSync(E2E_STATE_PREFIX);
    try {
      expect(assertDisposableStatePath(directory)).toBe(resolve(directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe("withDisposableState cleanup", () => {
  it("removes all state after a successful run", () => {
    let directory;
    withDisposableState((path) => {
      directory = path;
      writeFileSync(join(path, "created-by-test"), "data");
      expect(existsSync(path)).toBe(true);
    });
    expect(existsSync(directory)).toBe(false);
  });

  it("removes all state when setup or Playwright fails", () => {
    let directory;
    expect(() =>
      withDisposableState((path) => {
        directory = path;
        writeFileSync(join(path, "created-before-failure"), "data");
        throw new Error("injected failure");
      }),
    ).toThrow("injected failure");
    expect(existsSync(directory)).toBe(false);
  });
});
