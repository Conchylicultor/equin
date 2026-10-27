/**
 * Regression test for `paths:no-hardcoded-paths`: a hardcoded path inside a
 * `/* … *\/` block comment must be ignored, while a real one is still flagged.
 *
 * The detection now routes through `grepCode`, which masks comments (and regex
 * literals) before re-scanning — so the crude `startsWith("//")` skips (which
 * never caught block comments) are gone. This proves block comments are handled.
 *
 * `grepCode` shells out to `git grep`, so the test stands up a throwaway repo.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";

let root = "";

// The banned hardcoded path string, split so this test file does not itself
// match the pattern when the real check scans the repo.
const NEEDLE = "/" + "Users/";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "no-hardcoded-paths-test-"));
  const fixture = [
    "/*", // L1 — start of a block comment
    ` * legacy default was ${NEEDLE}alice/.equin`, // L2 — inside block comment
    " */", // L3
    `const real = "${NEEDLE}bob/data";`, // L4 — real code (string), the only match
  ].join("\n");
  writeFileSync(join(root, "fixture.ts"), fixture + "\n");

  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-q");
  await run("git", "config", "user.email", "t@t.t");
  await run("git", "config", "user.name", "t");
  await run("git", "add", "-A");
  await run("git", "commit", "-q", "-m", "fixture");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("hardcoded path in a block comment is ignored; a real one is flagged", async () => {
  // Mirrors the check: fixed-string git grep narrow + masked re-scan, with
  // maskStrings:false so the path inside a string literal still counts.
  const matches = await grepCode({
    root,
    pattern: new RegExp(NEEDLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    grepArg: NEEDLE,
    fixed: true,
    maskStrings: false,
  });

  expect(matches.length).toBe(1);
  expect(matches[0]!.line).toBe(4);
  expect(matches[0]!.text).toBe(`const real = "${NEEDLE}bob/data";`);
});
