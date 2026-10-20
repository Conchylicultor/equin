/**
 * `loadRepoFiles` against a throwaway git repo, so the git plumbing is real:
 * the universe (tracked + untracked, minus ignored and deleted), `under`'s
 * range, the path-spelling asserts, and `read`'s null cases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathsUnder } from "./pathspec";
import { loadRepoFiles } from "./repo-files";

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

let root = "";

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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "repo-files-"));
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
    expect((await rejection(repo.read("a//c.ts"))).message).toContain(
      "repo-relative",
    );
  });

  test("a git failure throws — never an empty set", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "repo-files-not-git-"));
    try {
      expect((await rejection(loadRepoFiles(notARepo))).message).toContain(
        "git ls-files",
      );
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

describe("pathsUnder", () => {
  test("returns a fresh array, so a caller cannot corrupt the set", () => {
    const sorted = Object.freeze([...EXPECTED]);
    const all = pathsUnder(sorted, "");
    all.pop();
    expect(pathsUnder(sorted, "")).toEqual(EXPECTED);
  });
});
