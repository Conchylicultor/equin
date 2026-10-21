/**
 * code-explorer's live reads against a real temp checkout, addressed by its
 * absolute toplevel (no attempt row, so nothing reads Postgres): each answers
 * what its GET route answers, and every failure the route answered with a
 * status is the read's declared refusal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodeDirEntries } from "./dir-value";
import { loadCodeFile, loadCodeFileDiff } from "./file-values";
import { readWorkspaceBytes } from "./workspace-bytes";
import { pinnedRefs } from "./workspace";

let base: string;
let repo: string;
let first: string;
let second: string;

function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "code-values-test-")));
  repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "sub", "b.txt"), "nested\n");
  mkdirSync(join(base, "plain"));
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
  git("add", ".");
  git("commit", "-q", "-m", "second");
  second = git("rev-parse", "HEAD");
  // A working-tree edit on top of HEAD.
  writeFileSync(join(repo, "a.txt"), "three\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The code of the refusal `p` rejects with. */
async function refusalCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error("expected a refusal");
}

describe("code.file", () => {
  test("reads the file on disk, and as of a ref", async () => {
    expect(await loadCodeFile({ worktree: repo, path: "a.txt" })).toEqual({
      content: "three\n",
    });
    expect(
      await loadCodeFile({ worktree: repo, path: "a.txt", ref: "HEAD" }),
    ).toEqual({ content: "two\n" });
    expect(
      await loadCodeFile({ worktree: repo, path: "a.txt", ref: first }),
    ).toEqual({ content: "one\n" });
  });

  test("refuses what the route answered with a status", async () => {
    const read = (path: string, ref?: string, worktree = repo) =>
      refusalCode(
        loadCodeFile({ worktree, path, ...(ref !== undefined ? { ref } : {}) }),
      );
    expect(await read("nope.txt")).toBe("missing");
    expect(await read("nope.txt", "HEAD")).toBe("missing");
    expect(await read("../outside.txt")).toBe("invalid-path");
    expect(await read(join(repo, "a.txt"))).toBe("invalid-path");
    expect(await read("a.txt", "origin/main")).toBe("invalid-ref");
    expect(await read("bin.dat")).toBe("binary");
    expect(await read("a.txt", undefined, join(base, "plain"))).toBe(
      "no-workspace",
    );
  });
});

describe("code.file-diff", () => {
  test("diffs the working tree against HEAD, and a range", async () => {
    const working = await loadCodeFileDiff({ worktree: repo, path: "a.txt" });
    expect(working.diff).toContain("-two");
    expect(working.diff).toContain("+three");
    const range = await loadCodeFileDiff({
      worktree: repo,
      path: "a.txt",
      base: first,
      head: second,
    });
    expect(range.diff).toContain("-one");
    expect(range.diff).toContain("+two");
    expect(
      (await loadCodeFileDiff({ worktree: repo, path: "sub/b.txt" })).diff,
    ).toBe("");
  });

  test("refuses a bad ref, a bad path and a missing file", async () => {
    expect(
      await refusalCode(
        loadCodeFileDiff({ worktree: repo, path: "a.txt", base: "nope" }),
      ),
    ).toBe("invalid-ref");
    expect(
      await refusalCode(loadCodeFileDiff({ worktree: repo, path: "../x" })),
    ).toBe("invalid-path");
    expect(
      await refusalCode(loadCodeFileDiff({ worktree: repo, path: "gone.txt" })),
    ).toBe("missing");
  });
});

describe("code.dir", () => {
  const root = () => ({ path: repo, git: true });

  test("lists a folder on disk, and as of a ref", async () => {
    const onDisk = await listCodeDirEntries(
      { worktree: repo, dir: "" },
      root(),
    );
    expect(onDisk.map((e) => e.name).sort()).toEqual([
      ".git",
      "a.txt",
      "bin.dat",
      "sub",
    ]);
    const atFirst = await listCodeDirEntries(
      { worktree: repo, dir: "", ref: first },
      root(),
    );
    expect(atFirst).toEqual(
      expect.arrayContaining([
        { name: "a.txt", kind: "file" },
        { name: "sub", kind: "dir" },
      ]),
    );
    expect(atFirst.some((e) => e.name === "bin.dat")).toBe(false);
  });

  test("refuses a missing folder, a path outside, a bad ref and no workspace", async () => {
    expect(
      await refusalCode(
        listCodeDirEntries({ worktree: repo, dir: "nope" }, root()),
      ),
    ).toBe("missing");
    expect(
      await refusalCode(
        listCodeDirEntries({ worktree: repo, dir: "../.." }, root()),
      ),
    ).toBe("invalid-path");
    expect(
      await refusalCode(
        listCodeDirEntries({ worktree: repo, dir: "", ref: "x/y" }, root()),
      ),
    ).toBe("invalid-ref");
    expect(
      await refusalCode(listCodeDirEntries({ worktree: "x", dir: "" }, null)),
    ).toBe("no-workspace");
    expect(
      await refusalCode(
        listCodeDirEntries(
          { worktree: "x", dir: "", ref: "HEAD" },
          { path: join(base, "plain"), git: false },
        ),
      ),
    ).toBe("not-a-checkout");
  });
});

describe("readWorkspaceBytes", () => {
  test("reads on disk and as of a ref, gating the size before the read", async () => {
    const onDisk = await readWorkspaceBytes(
      { workspace: repo, path: "a.txt" },
      1024,
    );
    expect(onDisk.kind === "ok" && new TextDecoder().decode(onDisk.bytes)).toBe(
      "three\n",
    );
    const atFirst = await readWorkspaceBytes(
      { workspace: repo, path: "a.txt", ref: first },
      1024,
    );
    expect(
      atFirst.kind === "ok" && new TextDecoder().decode(atFirst.bytes),
    ).toBe("one\n");
    expect(
      await readWorkspaceBytes(
        { workspace: repo, path: "a.txt", ref: first },
        2,
      ),
    ).toEqual({ kind: "too-large", size: 4 });
    expect(
      await readWorkspaceBytes({ workspace: repo, path: "a.txt" }, 2),
    ).toEqual({ kind: "too-large", size: 6 });
  });

  test("answers why there are no bytes", async () => {
    const read = (path: string, ref?: string, workspace = repo) =>
      readWorkspaceBytes(
        { workspace, path, ...(ref !== undefined ? { ref } : {}) },
        1024,
      );
    expect(await read("nope")).toEqual({ kind: "missing" });
    expect(await read("nope", "HEAD")).toEqual({ kind: "missing" });
    expect(await read("sub")).toEqual({ kind: "not-a-file" });
    expect(await read("sub", "HEAD")).toEqual({ kind: "not-a-file" });
    expect(await read("../x")).toEqual({ kind: "invalid-path" });
    expect(await read("a.txt", "a..b")).toEqual({ kind: "invalid-ref" });
    expect(await read("a.txt", undefined, join(base, "plain"))).toEqual({
      kind: "no-workspace",
    });
  });
});

describe("pinnedRefs", () => {
  test("a read at shas only (or at a non-ref) never moves", () => {
    expect(pinnedRefs([first, second])).toBe(true);
    expect(pinnedRefs(["abc1234"])).toBe(true);
    expect(pinnedRefs(["not a ref"])).toBe(true);
    expect(pinnedRefs([first, "HEAD"])).toBe(false);
    expect(pinnedRefs(["main"])).toBe(false);
  });
});
