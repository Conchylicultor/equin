import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushRangeOf } from "./push-range";

// A linear history root → a → b → c, every commit stamped with the SAME
// committer second: commit time cannot order them, ancestry must.
let base: string;
let repo: string;
const shas: Record<"root" | "a" | "b" | "c", string> = {
  root: "",
  a: "",
  b: "",
  c: "",
};

function git(...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "push-range-test-")));
  repo = join(base, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  for (const name of ["root", "a", "b", "c"] as const) {
    writeFileSync(join(repo, `${name}.txt`), name);
    git("add", ".");
    git("commit", "-q", "-m", name);
    shas[name] = git("rev-parse", "HEAD");
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("pushRangeOf", () => {
  test("orders a push's commits by ancestry, whatever order its rows come in", async () => {
    for (const order of [
      [shas.a, shas.b, shas.c],
      [shas.c, shas.a, shas.b],
      [shas.b, shas.c, shas.a],
    ]) {
      expect(await pushRangeOf(repo, "p", order)).toEqual({
        kind: "ok",
        baseSha: shas.root,
        headSha: shas.c,
      });
    }
  });

  test("a single-commit push diffs against its parent", async () => {
    expect(await pushRangeOf(repo, "p", [shas.b])).toEqual({
      kind: "ok",
      baseSha: shas.a,
      headSha: shas.b,
    });
  });

  test("a push starting at the root commit has no base", async () => {
    expect(await pushRangeOf(repo, "p", [shas.root, shas.a])).toEqual({
      kind: "no-base",
      first: shas.root,
    });
  });

  test("a commit missing from the store", async () => {
    expect(
      await pushRangeOf(repo, "p", [shas.a, "deadbeefdeadbeefdeadbeef"]),
    ).toEqual({ kind: "missing" });
  });

  test("a commit the ledger holds no row for is still one chain", async () => {
    expect(await pushRangeOf(repo, "p", [shas.a, shas.c])).toEqual({
      kind: "ok",
      baseSha: shas.root,
      headSha: shas.c,
    });
  });
});
