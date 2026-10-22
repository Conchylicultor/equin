/**
 * The run base's pure parts: which shard a file is in, a listing's hash, the
 * canonical file state, and the input comparison. (The store's round trip
 * and how a run uses it: `../check/run-base.test.ts`.)
 */

import { expect, test } from "bun:test";
import {
  fileBase,
  listingHash,
  messagesOf,
  rootHash,
  sameLintInputs,
  shardHash,
  shardOf,
  RUN_BASE_FORMAT,
  type RunBaseRoot,
} from "./run-base";

test("a file's shard is its deepest plugin, else its top directory", () => {
  expect(shardOf("plugins/shell/web/x.ts")).toBe("plugins/shell");
  expect(shardOf("plugins/shell/plugins/toast/web/deep/x.ts")).toBe(
    "plugins/shell/plugins/toast",
  );
  // A file named like a plugin directory is not one.
  expect(shardOf(["plugins", "shell", "plugins", "toast.ts"].join("/"))).toBe(
    "plugins/shell",
  );
  expect(shardOf("test/e2e/x.ts")).toBe("test");
  expect(shardOf("vite.config.ts")).toBe("");
});

test("a listing's hash is its set of (path, version), in any order", () => {
  const a = listingHash([
    ["x", "1"],
    ["y", "2"],
  ]);
  expect(
    listingHash([
      ["y", "2"],
      ["x", "1"],
    ]),
  ).toBe(a);
  expect(
    listingHash([
      ["x", "1"],
      ["y", "3"],
    ]),
  ).not.toBe(a);
  expect(listingHash([["x", "1"]])).not.toBe(a);
});

const msg = (line: number, ruleId = "r/x") => ({
  ruleId,
  fatal: false,
  line,
  column: 1,
  message: "m",
});

test("a file's state drops empty parts and is canonical whatever the build order", () => {
  const one = fileBase(
    "v",
    false,
    "r",
    { g2: [msg(3)], g1: [] },
    { t: [msg(1)] },
  );
  const two = fileBase(
    "v",
    false,
    "r",
    { g1: [], g2: [msg(3)] },
    { t: [msg(1)] },
  );
  expect(one).toEqual({
    v: "v",
    r: "r",
    s: { g2: [msg(3)] },
    t: { t: [msg(1)] },
  });
  expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  expect(shardHash({ files: { b: one, a: two } })).toBe(
    shardHash({ files: { a: two, b: one } }),
  );
  expect(fileBase("v", true, "r", {}, {})).toEqual({ v: "v", d: 1, r: "r" });
  // Messages read back in line order across parts.
  expect(messagesOf(one).map((m) => m.line)).toEqual([1, 3]);
});

test("inputs compare by every fingerprint, and a root's hash by its content", () => {
  const lint = { fps: { a: "1", b: "2" }, typed: { a: "3" }, allFp: "4" };
  expect(sameLintInputs(lint, { ...lint, fps: { b: "2", a: "1" } })).toBe(true);
  expect(sameLintInputs(lint, { ...lint, fps: { a: "1" } })).toBe(false);
  expect(sameLintInputs(lint, { ...lint, typed: {} })).toBe(false);
  expect(sameLintInputs(lint, { ...lint, allFp: "5" })).toBe(false);
  const root: RunBaseRoot = {
    format: RUN_BASE_FORMAT,
    treeHash: "t",
    lint,
    overlay: {},
    shards: { s: ["h", "l", 0, 1] },
  };
  expect(rootHash(root)).toBe(rootHash({ ...root, lint: { ...lint } }));
  expect(rootHash(root)).not.toBe(rootHash({ ...root, treeHash: "u" }));
});
