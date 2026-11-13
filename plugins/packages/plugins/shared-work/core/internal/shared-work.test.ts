import { describe, expect, test } from "bun:test";
import {
  installSharedWorkScope,
  markOwnInput,
  sharedMemo,
  sharedWork,
  type SharedWorkScope,
} from "./shared-work";

// A scope that records which work ran shared, under what name.
const ranShared: string[] = [];
const recording: SharedWorkScope = (name, fn) => {
  ranShared.push(name);
  return fn();
};
installSharedWorkScope(recording);

describe("sharedMemo", () => {
  test("produces once per key, as shared work", () => {
    ranShared.length = 0;
    let produced = 0;
    const memo = sharedMemo("tree", (_k: object) => ++produced);
    const key = {};
    expect(memo(key)).toBe(1);
    expect(memo(key)).toBe(1);
    expect(memo({})).toBe(2);
    expect(ranShared).toEqual(["tree", "tree"]);
  });

  test("over one unit's own input, the work is that unit's", () => {
    ranShared.length = 0;
    const memo = sharedMemo("tree", (_k: object) => "v");
    const own = {};
    markOwnInput(own);
    expect(memo(own)).toBe("v");
    expect(ranShared).toEqual([]);
  });

  test("the owner decides: a pass over an own set is that unit's", () => {
    ranShared.length = 0;
    const memo = sharedMemo("pass tree", (p: { repo: object }) => p.repo, {
      owner: (p) => p.repo,
    });
    const own = {};
    markOwnInput(own);
    memo({ repo: own });
    memo({ repo: {} });
    expect(ranShared).toEqual(["pass tree"]);
  });

  test("the first caller's arguments produce the value", () => {
    const memo = sharedMemo("ctx", (_k: object, n: number) => n);
    const key = {};
    expect(memo(key, 1)).toBe(1);
    expect(memo(key, 2)).toBe(1);
  });
});

describe("installSharedWorkScope", () => {
  test("meters compose: each installed scope sees every piece of shared work", () => {
    const second: string[] = [];
    ranShared.length = 0;
    installSharedWorkScope((name, fn) => {
      second.push(name);
      return fn();
    });
    expect(sharedWork("both", () => 7)).toBe(7);
    expect(ranShared).toEqual(["both"]);
    expect(second).toEqual(["both"]);
  });
});
