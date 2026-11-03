/**
 * `loadRepoFiles` against a throwaway git repo, so the git plumbing is real:
 * the universe (tracked + untracked, minus ignored and deleted), `under`'s
 * range, the path-spelling asserts, and `read`'s null cases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { pathsUnder } from "./pathspec";
import { loadRepoFiles, loadRepoSnapshot } from "./repo-files";

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

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** What git itself says `rel`'s working-tree content hashes to. */
async function blobOnDisk(rel: string): Promise<string> {
  return (await git("hash-object", rel)).trim();
}

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "repo-files-")));
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

describe("loadRepoFiles", () => {
  test("tracked + untracked, minus ignored and deleted, sorted and frozen", async () => {
    const repo = await loadRepoFiles(root);
    expect(repo.root).toBe(root);
    expect([...repo.all()]).toEqual(EXPECTED);
    expect(Object.isFrozen(repo.all())).toBe(true);
  });

  test("under(dir) is the subtree and nothing beside it", async () => {
    const repo = await loadRepoFiles(root);
    expect(repo.under("a")).toEqual(["a/b/x.ts", "a/b/y.ts", "a/c.ts"]);
    expect(repo.under("a/b")).toEqual(["a/b/x.ts", "a/b/y.ts"]);
    expect(repo.under("a/b/x.ts")).toEqual([]); // a file is not a directory
    expect(repo.under("zzz")).toEqual([]);
    expect(repo.under("")).toEqual(EXPECTED);
  });

  test("glob(pattern) is the pattern's match set", async () => {
    const repo = await loadRepoFiles(root);
    expect(repo.glob("a/**/*.ts")).toEqual(["a/b/x.ts", "a/b/y.ts", "a/c.ts"]);
    expect(repo.glob("a/**")).toEqual(repo.under("a"));
    expect(repo.glob("**/y.ts")).toEqual(["a/b/y.ts"]);
    expect(repo.glob("ignored/**")).toEqual([]);
  });

  test("has() is file membership", async () => {
    const repo = await loadRepoFiles(root);
    expect(repo.has("new.ts")).toBe(true);
    expect(repo.has("a/c.ts")).toBe(true);
    expect(repo.has("a")).toBe(false); // a directory
    expect(repo.has("ignored/i.ts")).toBe(false);
    expect(repo.has("gone.ts")).toBe(false);
  });

  test("a misspelled path throws instead of reading as absent", async () => {
    const repo = await loadRepoFiles(root);
    expect(() => repo.has("./a.ts")).toThrow("repo-relative");
    expect(() => repo.has("")).toThrow("repo-relative");
    expect(() => repo.under("a/")).toThrow("repo-relative");
    expect(() => repo.under("/a")).toThrow("repo-relative");
    expect(() => repo.under("a/../b")).toThrow("repo-relative");
    expect(repo.read("a//c.ts")).rejects.toThrow("repo-relative");
  });

  test("a git failure throws — never an empty set", async () => {
    const notARepo = asAppPath(
      mkdtempSync(join(tmpdir(), "repo-files-not-git-")),
    );
    try {
      expect(loadRepoFiles(notARepo)).rejects.toThrow("git ls-files");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("read()", () => {
  test("reads working-tree content", async () => {
    const repo = await loadRepoFiles(root);
    expect(await repo.read("a/c.ts")).toBe("// a/c.ts\n");
  });

  test("null for a file outside the set, even one on disk", async () => {
    const repo = await loadRepoFiles(root);
    expect(await repo.read("ignored/i.ts")).toBeNull();
    expect(await repo.read("nope.ts")).toBeNull();
  });

  test("null for a file in the set that vanished from disk", async () => {
    const repo = await loadRepoFiles(root);
    rmSync(join(root, "new.ts"));
    try {
      expect(await repo.read("new.ts")).toBeNull();
    } finally {
      write("new.ts", "// untracked, not ignored\n");
    }
  });

  test("thousands of reads at once all resolve (the gate queues them)", async () => {
    const repo = await loadRepoFiles(root);
    const reads = await Promise.all(
      Array.from({ length: 2000 }, () => repo.read("a.ts")),
    );
    expect(reads.every((r) => r === "// a.ts\n")).toBe(true);
  });
});

describe("loadRepoSnapshot", () => {
  test("the same set as loadRepoFiles", async () => {
    const snap = await loadRepoSnapshot(root);
    expect([...snap.all()]).toEqual(EXPECTED);
  });

  test("every member's blob is its working-tree content's id", async () => {
    write("a/c.ts", "// modified after the commit\n"); // tracked, dirty
    try {
      const snap = await loadRepoSnapshot(root);
      for (const p of snap.all()) {
        expect(snap.blobOf(p)).toBe(await blobOnDisk(p));
      }
    } finally {
      write("a/c.ts", "// a/c.ts\n");
    }
  });

  test("a stat-only change keeps the index id", async () => {
    const before = (await loadRepoSnapshot(root)).blobOf("a.ts");
    write("a.ts", "// a.ts\n"); // same bytes, new mtime
    expect((await loadRepoSnapshot(root)).blobOf("a.ts")).toBe(before);
  });

  test("extra: a named gitignored file becomes a hashed member", async () => {
    const snap = await loadRepoSnapshot(root, { extra: ["ignored/i.ts"] });
    expect(snap.has("ignored/i.ts")).toBe(true);
    expect(snap.blobOf("ignored/i.ts")).toBe(await blobOnDisk("ignored/i.ts"));
    expect([...snap.all()]).toEqual([...EXPECTED, "ignored/i.ts"].sort());
  });

  test("a missing extra fails loudly", async () => {
    expect(
      (await rejection(loadRepoSnapshot(root, { extra: ["ignored/nope.ts"] })))
        .message,
    ).toContain("hash-object");
  });

  test("blobOf a non-member throws — deleted, ignored, a directory", async () => {
    const snap = await loadRepoSnapshot(root);
    expect(() => snap.blobOf("gone.ts")).toThrow("not a file of the snapshot");
    expect(() => snap.blobOf("ignored/i.ts")).toThrow("not a file");
    expect(() => snap.blobOf("a")).toThrow("not a file");
    expect(() => snap.blobOf("./a.ts")).toThrow("repo-relative");
  });
});

describe("pathsUnder", () => {
  test("returns a fresh array, so a caller cannot corrupt the set", () => {
    const sorted = Object.freeze([...EXPECTED]);
    const all = pathsUnder(sorted, "");
    all.pop();
    expect(pathsUnder(sorted, "")).toEqual(EXPECTED);
  });
});
