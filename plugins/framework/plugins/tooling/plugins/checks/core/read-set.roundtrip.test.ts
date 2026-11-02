/**
 * End-to-end round-trip for the Stage-1 input-keyed cache, exercised the exact
 * way the runner drives it: record a read-set by running `grepCode` under a
 * recording `FileSystemView`, then `validate` that read-set against a FRESH
 * snapshot of a mutated tree with the SAME `gitGrepList` replay hook the runner
 * wires. Stands up a throwaway git repo so the git plumbing is real.
 *
 * Covers the four soundness cases that make the cache trustworthy:
 *   1. an UNRELATED change (a non-.ts file outside the read-set) is a HIT;
 *   2. a MATCHED file whose content moves (still matches `git grep -l`, but the
 *      blobSha changed — the WHERE-in-file hazard) is a MISS;
 *   3. a BRAND-NEW file that newly matches the grep predicate (H9) is a MISS;
 *   4. a check-logic change under a CHECK_SOURCE_PREFIX (parse-utils) is a MISS.
 * Plus: a .ts change that does NOT add/remove a matcher stays a HIT via the grep
 * replay (proving the replay hook, not just the in-memory pathspec gate).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { grepCode, gitGrepList } from "./grep-code";
import { withScanView } from "./scan-context";
import { computeTreeHash } from "./tree-hash";
import { loadTreeSnapshot, validate, type ReadSet, type QueryFact } from "./read-set";

let root!: AppPath;

// A check-logic file under a CHECK_SOURCE_PREFIX (parse-utils), so its content
// folds into the snapshot's checkSourceHash — the widened H0 coverage.
const PARSE_UTILS_FILE =
  "plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts";

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "read-set-roundtrip-")));
  // a.ts: the sole real `new WebSocket(` match. b.ts: an unrelated .ts (no
  // match). README.md: an unrelated non-.ts file. mask-source.ts: check-logic.
  write("a.ts", "foo();\nconst ws = new WebSocket(url);\n");
  write("b.ts", "const x = 1;\n");
  write("README.md", "# hello\n");
  write(PARSE_UTILS_FILE, "export function maskSource(s: string) { return s; }\n");
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Record a read-set by running the real grepCode under a recording view. */
async function record(): Promise<ReadSet> {
  const treeHash = await computeTreeHash(root);
  expect(treeHash).toBeTruthy();
  const snap = await loadTreeSnapshot(root, treeHash!);
  expect(snap).not.toBeNull();
  const view = snap!.createRecordingView();
  const matches = await withScanView(treeHash!, view, () =>
    grepCode({ root, pattern: /new WebSocket\(/, grepArg: "new WebSocket(", fixed: true }),
  );
  // Sanity: the fixture has exactly one real match, in a.ts.
  expect(matches.map((m) => m.path)).toEqual(["a.ts"]);
  return view.readSet();
}

/** Validate a read-set against a FRESH snapshot of the current tree state. */
async function revalidate(readSet: ReadSet) {
  const treeHash = await computeTreeHash(root);
  expect(treeHash).toBeTruthy();
  const snap = await loadTreeSnapshot(root, treeHash!);
  expect(snap).not.toBeNull();
  return validate(readSet, snap!, {
    replayQuery: (q: QueryFact) =>
      gitGrepList(snap!.root, q.grepArg, q.fixed, q.pathspecs, snap!.treeHash),
  });
}

test("recorded read-set captures the query selection AND per-candidate content", async () => {
  const rs = await record();
  // One query for the grep, one FileFact for the matched candidate.
  expect(rs.queries.map((q) => q.grepArg)).toEqual(["new WebSocket("]);
  expect(rs.queries[0]!.matches).toEqual(["a.ts"]);
  expect(rs.files.map((f) => f.path)).toEqual(["a.ts"]);
  // sourceHash is non-trivial: parse-utils IS under a CHECK_SOURCE_PREFIX.
  expect(rs.sourceHash).toMatch(/^[0-9a-f]{64}$/);
});

test("case 1: an unrelated (non-.ts) change is a HIT", async () => {
  const rs = await record();
  write("README.md", "# hello world — edited, unrelated\n");
  try {
    const v = await revalidate(rs);
    expect(v.hit).toBe(true);
  } finally {
    write("README.md", "# hello\n");
  }
});

test("case 1b: a .ts change that adds no new matcher stays a HIT (via grep replay)", async () => {
  const rs = await record();
  // b.ts is a .ts file → inside the pathspec superset → its edit flips the
  // pathspec fingerprint, so `validate` MUST re-run `git grep -l`. b.ts still
  // has no `new WebSocket(`, so the match set is unchanged → HIT.
  write("b.ts", "const x = 2;\nconst y = 3;\n");
  try {
    const v = await revalidate(rs);
    expect(v.hit).toBe(true);
  } finally {
    write("b.ts", "const x = 1;\n");
  }
});

test("case 2: a matched file whose token MOVES (still grep-matches) is a MISS", async () => {
  const rs = await record();
  // a.ts still contains `new WebSocket(` (git grep -l match set is UNCHANGED),
  // but the token moved to a different line → blobSha changed. Only the recorded
  // FileFact catches this WHERE-in-file flip; a query-only cache would stale-PASS.
  write("a.ts", "const ws = new WebSocket(url);\nfoo();\n");
  try {
    const v = await revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("a.ts");
  } finally {
    write("a.ts", "foo();\nconst ws = new WebSocket(url);\n");
  }
});

test("case 3 (H9): a brand-new file that newly matches the predicate is a MISS", async () => {
  const rs = await record();
  write("c.ts", "const w = new WebSocket(x);\n");
  try {
    const v = await revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("query match set changed");
  } finally {
    rmSync(join(root, "c.ts"), { force: true });
  }
});

test("case 4: a check-logic (parse-utils) change flips sourceHash → MISS", async () => {
  const rs = await record();
  write(PARSE_UTILS_FILE, "export function maskSource(s: string) { return s.trim(); }\n");
  try {
    const v = await revalidate(rs);
    expect(v.hit).toBe(false);
    if (!v.hit) expect(v.reason).toContain("source");
  } finally {
    write(PARSE_UTILS_FILE, "export function maskSource(s: string) { return s; }\n");
  }
});
