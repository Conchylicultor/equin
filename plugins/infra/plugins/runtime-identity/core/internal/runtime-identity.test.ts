import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  declareRuntimeNamespace,
  isMain,
  resetRuntimeNamespaceForTest,
  runtimeNamespace,
} from "./runtime-identity";

// The declaration is module-global, and the `bun test` preload has already made
// one for the whole process — so every test here resets first and puts the
// process's answer back afterwards, exactly as the one production suite that
// simulates several worktrees does.
//
// Captured per-test rather than once at module load: other suites in the same
// process legitimately swap the declaration for their own duration, and reading
// it at import time would restore whatever happened to be set then.

let original: Namespace;

beforeEach(() => {
  original = runtimeNamespace();
  resetRuntimeNamespaceForTest();
});

afterEach(() => {
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(original);
});

describe("runtimeNamespace", () => {
  test("answers what was declared", () => {
    declareRuntimeNamespace(asNamespace("att-1234-abcd"));
    expect(runtimeNamespace()).toBe(asNamespace("att-1234-abcd"));
  });

  test("throws when nothing declared one, naming both ways to get one", () => {
    expect(() => runtimeNamespace()).toThrow(/--namespace/);
    expect(() => runtimeNamespace()).toThrow(/checkoutNamespace/);
  });
});

describe("declareRuntimeNamespace", () => {
  test("is idempotent for the same value", () => {
    declareRuntimeNamespace(asNamespace("sonata.att-1234"));
    declareRuntimeNamespace(asNamespace("sonata.att-1234"));
    expect(runtimeNamespace()).toBe(asNamespace("sonata.att-1234"));
  });

  test("throws on a different value, naming both", () => {
    declareRuntimeNamespace(asNamespace("att-1234-abcd"));
    expect(() =>
      declareRuntimeNamespace(asNamespace(MAIN_WORKTREE_NAME)),
    ).toThrow(/att-1234-abcd/);
    // The first answer stands — a refused redeclare must not half-apply.
    expect(runtimeNamespace()).toBe(asNamespace("att-1234-abcd"));
  });
});

describe("isMain", () => {
  test("is true only for the main namespace", () => {
    declareRuntimeNamespace(MAIN_WORKTREE_NAME);
    expect(isMain()).toBe(true);
    resetRuntimeNamespaceForTest();
    declareRuntimeNamespace(asNamespace("att-1234-abcd"));
    expect(isMain()).toBe(false);
  });

  test("is false when nothing declared one — a CLI is never main", () => {
    expect(isMain()).toBe(false);
  });
});
