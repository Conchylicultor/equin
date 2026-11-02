/**
 * Tests for `grepCode`. Run with `bun test` from the repo root.
 *
 * `grepCode` shells out to `git grep` to narrow candidate files, so these tests
 * stand up a throwaway git repo with a fixture file. The fixture writes the same
 * marker into real code, a comment and a string — only the real-code line must
 * survive the mask-and-rescan.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  GitScanError,
  gitGrepList,
  grepCode,
  listCandidateSources,
} from "./grep-code";
import { withScanView } from "./scan-context";
import { computeTreeHash } from "./tree-hash";

let root!: AppPath;

beforeAll(async () => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "grep-code-test-")));
  const fixture = [
    "// new WebSocket(commented) should be ignored", // L1
    'const note = "new WebSocket(stringed) ignored too";', // L2
    "const ws = new WebSocket(url);", // L3 — the only real match
    "const r = /new WebSocket\\(/; // regex literal ignored", // L4
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

test("grepCode returns only real-code matches, skipping comments/strings/regex", async () => {
  const matches = await grepCode({
    root,
    pattern: /new WebSocket\(/,
    grepArg: "new WebSocket(",
    fixed: true,
    maskStrings: true,
  });
  expect(matches.length).toBe(1);
  expect(matches[0]!.path).toBe("fixture.ts");
  expect(matches[0]!.line).toBe(3);
  expect(matches[0]!.text).toBe("const ws = new WebSocket(url);");
});

test("grepCode (no scan tree) scans untracked files via the working-tree fallback", async () => {
  // The pre-fix blind spot: a brand-new, not-yet-committed file. `--untracked`
  // means an uncached run still sees it.
  const f = join(root, "untracked_fallback.ts");
  writeFileSync(f, "const ws = new WebSocket(url);\n");
  try {
    const matches = await grepCode({
      root,
      pattern: /new WebSocket\(/,
      grepArg: "new WebSocket(",
      fixed: true,
    });
    expect(
      matches.some((m) => m.path === "untracked_fallback.ts" && m.line === 1),
    ).toBe(true);
  } finally {
    rmSync(f, { force: true });
  }
});

test("grepCode scans the ambient scan tree — incl. files untracked when it was written", async () => {
  // This is the cache-correctness invariant: the cache key is computeTreeHash's
  // tree (which includes untracked files via `add -A`), so grepCode must scan
  // THAT tree's bytes — not the working copy, which may differ or not yet track
  // the file. Without this, a PASS could be recorded for content never scanned.
  const f = join(root, "untracked_tree.ts");
  writeFileSync(f, "const ws = new WebSocket(url);\n"); // untracked at write-tree time
  const tree = await computeTreeHash(root);
  expect(tree).toBeTruthy();

  // Mutate the working copy so a working-tree grep would see DIFFERENT content.
  writeFileSync(f, "const x = 1;\n");
  try {
    const matches = await withScanView(tree, null, () =>
      grepCode({
        root,
        pattern: /new WebSocket\(/,
        grepArg: "new WebSocket(",
        fixed: true,
      }),
    );
    // Found via the tree blob (its untracked-at-write-time content), proving the
    // scan reads the tree, not the now-mutated working file.
    expect(
      matches.some((m) => m.path === "untracked_tree.ts" && m.line === 1),
    ).toBe(true);
  } finally {
    rmSync(f, { force: true });
  }
});

test("grepCode returns [] when git grep finds nothing", async () => {
  const matches = await grepCode({
    root,
    pattern: /zzz_no_such_token_zzz/,
    grepArg: "zzz_no_such_token_zzz",
    fixed: true,
  });
  expect(matches).toEqual([]);
});

// A pattern git rejects (here: an unbalanced ERE group) exits 128 with empty
// stdout. It must fail loudly, never read as "no matches" — otherwise a check
// with a broken pattern passes without ever having searched.
test("grepCode throws GitScanError when git rejects the pattern", async () => {
  const run = grepCode({
    root,
    pattern: /var\(--/,
    grepArg: "var(--(font-size",
  });
  expect(run).rejects.toBeInstanceOf(GitScanError);
  expect(run).rejects.toThrow(/exit 128/);
});

test("listCandidateSources throws when git rejects the pattern", async () => {
  expect(
    listCandidateSources({ root, grepArg: "WebSocket(" }),
  ).rejects.toBeInstanceOf(GitScanError);
});

test("gitGrepList throws on a bad pattern against a scan tree", async () => {
  const tree = await computeTreeHash(root);
  expect(
    gitGrepList(root, "WebSocket(", false, ["*.ts"], tree),
  ).rejects.toBeInstanceOf(GitScanError);
});

test("gitGrepList throws on an unknown tree-ish", async () => {
  expect(
    gitGrepList(root, "WebSocket", true, ["*.ts"], "0".repeat(40)),
  ).rejects.toBeInstanceOf(GitScanError);
});
