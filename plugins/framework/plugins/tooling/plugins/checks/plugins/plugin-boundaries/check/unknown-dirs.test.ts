/**
 * R11 answers "which directories does this plugin have, and do they hold
 * TypeScript?" from the run's git-backed enumeration, so it cannot raise a
 * violation from content the `inputKeyed` cache key does not cover.
 *
 * The regression this pins is the directory half of
 * research/2026-09-09-tooling-check-file-enumeration-from-git.md: the rule used
 * to `readdirSync` a plugin folder and recurse to look for `.ts` files, with a
 * deny-list naming only `node_modules`. A gitignored directory holding
 * TypeScript inside a plugin — `dist/`, `test-results/`, a nested `.cache/` the
 * recursion reached — produced a real `unknown-dir` violation from content no
 * commit contains.
 *
 * The composition under test is what `run()` does: `listRepoFiles` over a real
 * throwaway git repo, then `repoTree`, then the rule.
 *
 * NOTE: fixture paths go through `pj(rel)` rather than bare `plugins/<seg>/…`
 * literals — the repo's own `plugin-refs-resolve` check validates that every
 * such literal in source resolves to a real plugin, and these are synthetic.
 */

import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core/testing";
import { repoTree } from "./repo-tree";
import { collectUnknownDirViolations } from "./unknown-dirs";

let root = "";

/** Build a repo-relative path under the synthetic plugins/ tree. */
const pj = (rel: string): string => `plugins/${rel}`;

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const KNOWN = new Set(["web", "server", "core", "shared", "check", "plugins"]);

const IGNORES = ".cache/\ndist/\ndist.*/\nnode_modules/\ntest-results/\n";

/** Run R11 over `foo` exactly as `run()` does, against the repo's live state. */
async function violationsForFoo(): Promise<string[]> {
  const repo = repoTree(await listRepoFiles(asAppPath(root)));
  return collectUnknownDirViolations({
    pluginRelPath: "foo",
    allPluginRelPaths: ["foo", "foo/plugins/bar"],
    known: KNOWN,
    repo,
  }).map((v) => v.file);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "plugin-boundaries-unknown-dirs-"));
  write(".gitignore", IGNORES);
  write(pj("foo/package.json"), JSON.stringify({ name: "foo" }) + "\n");
  write(pj("foo/web/index.ts"), "export default {} as unknown;\n");
  // A child plugin — recognized by name, never an unknown dir.
  write(pj("foo/plugins/bar/core/index.ts"), "export const bar = 1;\n");
  // A tracked dot-directory holding TypeScript. gitignore does NOT hide it, so
  // only the rule's own dot-name exclusion keeps it from being a violation.
  write(pj("foo/.claude/hook.ts"), "export const hook = 1;\n");
  // A non-code asset directory: unrecognized, but holds no TypeScript.
  write(pj("foo/migrations/0001_init.sql"), "select 1;\n");
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");

  // Written AFTER the commit, exactly as a build or an agent leaves them.
  write(pj("foo/dist/bundle.ts"), "export const bundled = 1;\n");
  write(pj("foo/dist.staging.abc/bundle.ts"), "export const bundled = 1;\n");
  write(pj("foo/.cache/scratch/probe.ts"), "export const x: number = 1;\n");
  write(pj("foo/node_modules/dep/index.ts"), "module.exports = {};\n");
  write(pj("foo/test-results/report.ts"), "export const report = 1;\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "second");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a gitignored directory holding .ts inside a plugin raises no unknown-dir", async () => {
  // dist/ and .cache/ are the two shapes the deleted walk got wrong: one its
  // deny-list named but its RECURSION did not re-apply, one it never named.
  expect(await violationsForFoo()).toEqual([]);
});

test("the gitignored directories are invisible to the tree, not merely unflagged", async () => {
  const repo = repoTree(await listRepoFiles(asAppPath(root)));
  const subdirs = [...repo.subdirs(pj("foo"))].sort();
  expect(subdirs).toEqual([".claude", "migrations", "plugins", "web"]);
  expect(repo.containsTsFiles(pj("foo/dist"))).toBe(false);
  expect(repo.containsTsFiles(pj("foo/.cache"))).toBe(false);
  expect(repo.containsTsFiles(pj("foo/test-results"))).toBe(false);
  // Nested two deep under an ignored dir — the deleted walk's recursion
  // re-applied only `node_modules`, so it reached this one.
  expect(repo.containsTsFiles(pj("foo/.cache/scratch"))).toBe(false);
});

test("an unrecognized directory holding visible TypeScript IS flagged", async () => {
  // Un-ignoring test-results/ — nothing else changes — turns the same bytes on
  // disk into exactly what R11 exists to catch. The rule's silence above is
  // gitignore's doing, not a blanket name exclusion.
  write(".gitignore", IGNORES.replace("test-results/\n", ""));
  try {
    expect(await violationsForFoo()).toEqual([pj("foo/test-results/")]);
  } finally {
    write(".gitignore", IGNORES);
  }
});

test("dot-directories are excluded on meaning, even when tracked", async () => {
  // `.claude/` holds a tracked .ts and is not gitignored — only the rule's own
  // dot-name rule keeps it out.
  const repo = repoTree(await listRepoFiles(asAppPath(root)));
  expect(repo.containsTsFiles(pj("foo/.claude"))).toBe(true);
  expect(
    collectUnknownDirViolations({
      pluginRelPath: "foo",
      allPluginRelPaths: ["foo"],
      known: KNOWN,
      repo,
    }).map((v) => v.file),
  ).not.toContain(pj("foo/.claude/"));
});

test("an unrecognized directory holding no TypeScript is not flagged", async () => {
  const repo = repoTree(await listRepoFiles(asAppPath(root)));
  expect(repo.subdirs(pj("foo")).has("migrations")).toBe(true);
  expect(repo.containsTsFiles(pj("foo/migrations"))).toBe(false);
  expect(await violationsForFoo()).not.toContain(pj("foo/migrations/"));
});
