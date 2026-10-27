import { describe, expect, test } from "bun:test";
import {
  cacheEntryOf,
  claudeProjectDirName,
  isHistoryRecord,
  rewriteDbValue,
  rewriteText,
} from "./rewrite";

const MOVES = [{ from: "/home/u/.old", to: "/home/u/.equin" }];

describe("rewriteText", () => {
  test("rewrites every path under the prefix, and the prefix itself", () => {
    expect(
      rewriteText(
        '{"a":"/home/u/.old/state/x","b":"/home/u/.old","c":"see /home/u/.old/y"}',
        MOVES,
      ),
    ).toBe(
      '{"a":"/home/u/.equin/state/x","b":"/home/u/.equin","c":"see /home/u/.equin/y"}',
    );
  });

  test("leaves a sibling directory that merely starts like it", () => {
    expect(rewriteText("/home/u/.old-clean-install/x", MOVES)).toBe(
      "/home/u/.old-clean-install/x",
    );
  });
});

describe("rewriteDbValue", () => {
  test("a value that is a path is rewritten", () => {
    expect(rewriteDbValue("/home/u/.old/apps/a.png", MOVES)).toBe(
      "/home/u/.equin/apps/a.png",
    );
    expect(rewriteDbValue("/home/u/.old", MOVES)).toBe("/home/u/.equin");
  });

  test("a mention inside prose is history, left as written", () => {
    expect(rewriteDbValue("look in /home/u/.old/logs", MOVES)).toBeNull();
    expect(rewriteDbValue("/home/u/.older/x", MOVES)).toBeNull();
  });
});

describe("isHistoryRecord", () => {
  test.each([
    ["logs/gateway/x.log", true],
    ["state/sdk-agents/ns/conv/launch.json", true],
    ["worktrees/ns/runs/build-1.log", true],
    ["op-log.jsonl.2", true],
    ["apps/browser/profile/Default/LOG.old", true],
    ["worktrees/ns/spec.json", false],
    ["state/db-config/database.json", false],
  ])("%s → %p", (rel, expected) => {
    expect(isHistoryRecord(rel)).toBe(expected);
  });
});

test("cacheEntryOf", () => {
  expect(cacheEntryOf("cache/deps/chromium/abc/env/x.json")).toBe(
    "cache/deps/chromium",
  );
  expect(cacheEntryOf("cache/check")).toBe("cache/check");
  expect(cacheEntryOf("state/x")).toBeNull();
});

test("claudeProjectDirName", () => {
  expect(claudeProjectDirName("/home/u/.equin/state/workspaces/att-1")).toBe(
    "-home-u--equin-state-workspaces-att-1",
  );
});
