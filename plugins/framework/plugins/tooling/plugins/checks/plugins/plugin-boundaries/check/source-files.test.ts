/**
 * plugin-boundaries scans exactly the git-derived file set its `inputKeyed`
 * cache key represents — the pairing the old filesystem walk broke.
 *
 * The regression this pins is the one from
 * research/2026-09-09-tooling-check-file-enumeration-from-git.md: a stray `.ts`
 * under a gitignored directory inside `plugins/` was walked and scanned for
 * boundary violations, while the read-set's `view.glob("plugins/**")` — taken
 * over the git tree snapshot — could not see it. So the PASS was recorded
 * against content the key did not cover.
 *
 * The composition under test is what `run()` does: `listRepoFiles` over a real
 * throwaway git repo, then `selectSourceFiles`.
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
import { listRepoFiles } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { selectSourceFiles } from "./source-files";

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

const FOO_SOURCE = pj("foo/web/index.ts");
const FOO_TSX = pj("foo/web/App.tsx");
const FOO_README = pj("foo/README.md");
const IGNORED_SOURCE = pj("foo/.cache/probe.ts");
const IGNORED_DIST_SOURCE = pj("foo/dist.staging.abc/bundle.ts");
const NODE_MODULES_SOURCE = pj("foo/node_modules/dep/index.ts");
const OUTSIDE_SOURCE = "cli/main.ts";

async function sources(): Promise<string[]> {
  return selectSourceFiles(await listRepoFiles(asAppPath(root)));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "plugin-boundaries-source-files-"));
  write(
    ".gitignore",
    // The three shapes the deleted walk's `IGNORED_DIRS` could not express:
    // a dir it never named (.cache), a `dist` VARIANT it did not match, and
    // node_modules — which it did name, and which gitignore covers anyway.
    ".cache/\ndist.*/\nnode_modules/\n",
  );
  write(FOO_SOURCE, "export default {} as unknown;\n");
  write(FOO_TSX, "export const App = null;\n");
  write(FOO_README, "# foo\n");
  write(OUTSIDE_SOURCE, "export const main = 1;\n");
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");

  // Written AFTER the commit, exactly as an agent leaves them mid-session.
  write(IGNORED_SOURCE, "export const x: number = 1;\n");
  write(IGNORED_DIST_SOURCE, "export const y = 1;\n");
  write(NODE_MODULES_SOURCE, "module.exports = {};\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a .ts under a gitignored directory inside plugins/ is not scanned", async () => {
  const files = await sources();
  expect(files).not.toContain(IGNORED_SOURCE);
  expect(files).not.toContain(IGNORED_DIST_SOURCE);
  expect(files).not.toContain(NODE_MODULES_SOURCE);
});

test("selects the committed .ts/.tsx sources under plugins/, and nothing else", async () => {
  expect(await sources()).toEqual([FOO_TSX, FOO_SOURCE].sort());
});

test("a brand-new uncommitted source IS scanned — the untracked case the walk existed for", async () => {
  const added = pj("foo/web/added.tsx");
  write(added, "export const Added = null;\n");
  try {
    expect(await sources()).toContain(added);
  } finally {
    rmSync(join(root, added));
  }
});

test("a source deleted from the worktree but still in the index is not scanned", async () => {
  // `git ls-files --cached` still lists it; reading it would throw. listRepoFiles
  // subtracts `--deleted` so the check never sees a file that is not there.
  rmSync(join(root, FOO_TSX));
  try {
    expect(await sources()).not.toContain(FOO_TSX);
  } finally {
    write(FOO_TSX, "export const App = null;\n");
  }
});

test("selectSourceFiles is a pure filter over the supplied list", () => {
  expect(
    selectSourceFiles([
      pj("a/core/x.ts"),
      pj("a/core/x.d.ts"),
      pj("a/CLAUDE.md"),
      pj("a/package.json"),
      "web/main.tsx",
      "plugins-adjacent/y.ts",
    ]),
  ).toEqual([pj("a/core/x.ts"), pj("a/core/x.d.ts")]);
});
