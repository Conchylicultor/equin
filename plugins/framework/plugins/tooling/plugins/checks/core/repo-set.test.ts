/**
 * `ctx.repo()` against a throwaway git repo, so the git plumbing is real. Pins:
 * the two sources (tree snapshot, loadRepoFiles) give the same set; the run
 * memo and its fallback; and the recording wrapper's facts replaying soundly.
 * The list-backed set itself (`under`, spelling asserts, `read`) is pinned in
 * `tooling/core/repo-files.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  loadRepoFiles,
  repoFilesOver,
} from "@plugins/framework/plugins/tooling/core";
import { computeTreeHash } from "./tree-hash";
import { loadTreeSnapshot, validate, type TreeSnapshot } from "./read-set";
import { recordingRepoFiles, runRepoFiles } from "./repo-set";

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (the same helper
 * the op-runtime, spawn and host-semaphore suites carry).
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

let root!: AppPath;

// Sorted (code-unit order). `a-b.ts` ("-" < "/") and `a.ts` ("." < "/") sort
// BEFORE the `a/` run, `a0.ts` ("0" is right after "/") right AFTER it — the
// two edges `under("a")`'s range must not cross.
const EXPECTED = [
  ".gitignore",
  "README.md",
  "a-b.ts",
  "a.ts",
  "a/b/x.ts",
  "a/b/y.ts",
  "a/c.ts",
  "a0.ts",
  "new.ts",
];

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

async function snapshot(): Promise<TreeSnapshot> {
  const treeHash = await computeTreeHash(root);
  expect(treeHash).toBeTruthy();
  const snap = await loadTreeSnapshot(root, treeHash!);
  expect(snap).not.toBeNull();
  return snap!;
}

beforeAll(async () => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "repo-set-")));
  write(".gitignore", "ignored/\n");
  for (const rel of [
    "README.md",
    "a-b.ts",
    "a.ts",
    "a/b/x.ts",
    "a/b/y.ts",
    "a/c.ts",
    "a0.ts",
    "gone.ts",
  ]) {
    write(rel, `// ${rel}\n`);
  }
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
  rmSync(join(root, "gone.ts")); // tracked, deleted from disk, not staged
  write("new.ts", "// untracked, not ignored\n");
  write("ignored/i.ts", "// on disk, gitignored\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the set", () => {
  test("the snapshot and loadRepoFiles give the same set: tracked + untracked, minus ignored and deleted", async () => {
    expect([...(await snapshot()).paths()]).toEqual(EXPECTED);
    expect([...(await loadRepoFiles(root)).all()]).toEqual(EXPECTED);
  });
});

describe("runRepoFiles (the run's ctx.repo)", () => {
  test("loads once, however many checks ask", async () => {
    const snap = await snapshot();
    let loads = 0;
    const repo = runRepoFiles({
      loadSnapshot: () => {
        loads++;
        return Promise.resolve(snap);
      },
      root: () => Promise.resolve(root),
    });
    const [a, b] = await Promise.all([repo(), repo()]);
    expect(a).toBe(b);
    expect(await repo()).toBe(a);
    expect(loads).toBe(1);
    expect([...a.all()]).toEqual(EXPECTED);
  });

  test("no snapshot (--no-cache, or a failed load) falls back to loadRepoFiles", async () => {
    const repo = runRepoFiles({
      loadSnapshot: () => Promise.resolve(null),
      root: () => Promise.resolve(root),
    });
    expect([...(await repo()).all()]).toEqual(EXPECTED);
  });

  test("a failing fallback rejects — never an empty set", async () => {
    const notARepo = asAppPath(
      mkdtempSync(join(tmpdir(), "repo-set-not-git-")),
    );
    try {
      const repo = runRepoFiles({
        loadSnapshot: () => Promise.resolve(null),
        root: () => Promise.resolve(notARepo),
      });
      expect((await rejection(repo())).message).toContain("git ls-files");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("recording (input-keyed checks)", () => {
  test("the subtree glob fast path answers exactly what the pathspec regex does", async () => {
    const snap = await snapshot();
    for (const dir of ["", "a", "a/b", "a/b/x.ts", "a-b.ts", "zzz"]) {
      const pattern = dir === "" ? "**" : `${dir}/**`;
      expect(snap.glob(pattern)).toEqual(snap.matchPathspecs([pattern]));
    }
    // A fresh array: a caller mutating it cannot corrupt the snapshot.
    snap.glob("**").pop();
    expect([...snap.paths()]).toEqual(EXPECTED);
  });

  test("what a check reads through ctx.repo() lands in its read-set", async () => {
    const snap = await snapshot();
    const view = snap.createRecordingView();
    const repo = recordingRepoFiles(
      repoFilesOver(snap.root, snap.paths()),
      view,
    );
    expect(repo.under("a")).toEqual(["a/b/x.ts", "a/b/y.ts", "a/c.ts"]);
    expect(repo.has("a.ts")).toBe(true);
    expect(repo.has("missing.ts")).toBe(false);
    expect(await repo.read("a/c.ts")).toBe("// a/c.ts\n");
    const rs = view.readSet();
    expect(rs.globs).toEqual([
      { glob: "a/**", matches: ["a/b/x.ts", "a/b/y.ts", "a/c.ts"] },
    ]);
    expect(rs.files.map((f) => f.path)).toEqual(["a.ts", "a/c.ts"]);
    expect(rs.absent).toEqual(["missing.ts"]);
  });

  test("all() records the whole tree's membership", async () => {
    const snap = await snapshot();
    const view = snap.createRecordingView();
    const repo = recordingRepoFiles(
      repoFilesOver(snap.root, snap.paths()),
      view,
    );
    expect(repo.all()).toEqual(EXPECTED);
    expect(view.readSet().globs).toEqual([{ glob: "**", matches: EXPECTED }]);
  });

  test("replay: unrelated edit HITs; a new file under the subtree, an edited read, a created probe each MISS", async () => {
    const snap = await snapshot();
    const view = snap.createRecordingView();
    const repo = recordingRepoFiles(
      repoFilesOver(snap.root, snap.paths()),
      view,
    );
    repo.under("a");
    repo.has("missing.ts");
    await repo.read("a.ts");
    const rs = view.readSet();

    write("README.md", "# edited, unrelated\n");
    try {
      expect((await validate(rs, await snapshot())).hit).toBe(true);
    } finally {
      write("README.md", "// README.md\n");
    }

    const miss = async (
      mutate: () => void,
      undo: () => void,
      reason: string,
    ) => {
      mutate();
      try {
        const v = await validate(rs, await snapshot());
        expect(v.hit).toBe(false);
        if (!v.hit) expect(v.reason).toContain(reason);
      } finally {
        undo();
      }
    };
    await miss(
      () => write("a/b/z.ts", "//\n"),
      () => rmSync(join(root, "a/b/z.ts")),
      "glob match set changed: a/**",
    );
    await miss(
      () => write("a.ts", "// edited\n"),
      () => write("a.ts", "// a.ts\n"),
      "file changed or removed: a.ts",
    );
    await miss(
      () => write("missing.ts", "//\n"),
      () => rmSync(join(root, "missing.ts")),
      "previously-absent path now present: missing.ts",
    );
  });
});
