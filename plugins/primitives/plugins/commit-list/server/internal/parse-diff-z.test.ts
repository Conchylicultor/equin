import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDiffNameStatusZ,
  parseDiffNumstatZ,
  parseDiffRawNumstatZ,
} from "./parse-diff-z";
import { runGit } from "./run-git";

// A real repo: the layout under test is git's, so a hand-written fixture would
// only test our reading of it.
let repo: string;
let base: string;

const ODD = 'odd "quoted"\tname\nnl é.txt';
const COLON = ":starts-with-colon.txt";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "parse-diff-z-test-"));
  const git = (...args: string[]) => runGit(args, repo);
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "orig.txt"), "a\nb\nc\nd\ne\nf\ng\n");
  await writeFile(join(repo, "src.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  await writeFile(join(repo, "m.txt"), "x\n");
  await writeFile(join(repo, "bin.dat"), new Uint8Array([0, 1, 2]));
  await writeFile(join(repo, "gone.txt"), "del\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "initial");
  base = (await git("rev-parse", "HEAD")).trim();

  await git("mv", "orig.txt", ODD); // rename to a quote/tab/newline/non-ASCII path
  await writeFile(join(repo, "copy.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n"); // copy of src + 1 line
  await writeFile(join(repo, "m.txt"), "x\ny\nz\n");
  await writeFile(join(repo, "bin.dat"), new Uint8Array([0, 3, 4]));
  await git("rm", "-q", "gone.txt");
  await writeFile(join(repo, COLON), "n\n");
  await git("add", "-A");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

const diff = (...flags: string[]) =>
  runGit(
    ["diff", "-M", "-C", "--find-copies-harder", "-z", ...flags, base],
    repo,
  );

describe("parseDiffRawNumstatZ (real git)", () => {
  test("one record per path: status, rename/copy source, counts, binary", async () => {
    const records = parseDiffRawNumstatZ(await diff("--raw", "--numstat"));
    const byPath = new Map(records.map((r) => [r.path, r]));
    expect(records.length).toBe(byPath.size);

    expect(byPath.get(ODD)).toEqual({
      status: "renamed",
      path: ODD,
      from: "orig.txt",
      additions: 0,
      deletions: 0,
      binary: false,
    });
    expect(byPath.get("copy.txt")).toEqual({
      status: "copied",
      path: "copy.txt",
      from: "src.txt",
      additions: 1,
      deletions: 0,
      binary: false,
    });
    expect(byPath.get("m.txt")).toMatchObject({
      status: "modified",
      additions: 2,
      deletions: 0,
    });
    expect(byPath.get("bin.dat")).toMatchObject({
      status: "modified",
      additions: 0,
      deletions: 0,
      binary: true,
    });
    expect(byPath.get("gone.txt")).toMatchObject({
      status: "deleted",
      deletions: 1,
    });
    expect(byPath.get(COLON)).toMatchObject({ status: "added", additions: 1 });
  });

  test("agrees with the separate name-status and numstat parses", async () => {
    const combined = parseDiffRawNumstatZ(await diff("--raw", "--numstat"));
    const names = parseDiffNameStatusZ(await diff("--name-status"));
    const counts = parseDiffNumstatZ(await diff("--numstat"));
    const sortBy = <T extends { path: string }>(xs: T[]) =>
      [...xs].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(
      sortBy(combined).map(({ status, path, from }) => ({
        status,
        path,
        ...(from === undefined ? {} : { from }),
      })),
    ).toEqual(sortBy(names));
    expect(
      sortBy(combined).map(({ path, from, additions, deletions, binary }) => ({
        additions,
        deletions,
        path,
        ...(from === undefined ? {} : { from }),
        binary,
      })),
    ).toEqual(sortBy(counts));
  });

  test("an empty diff is no records", () => {
    expect(parseDiffRawNumstatZ("")).toEqual([]);
  });

  test("a count with no status is a layout it does not know: a throw", () => {
    expect(() => parseDiffRawNumstatZ("1\t0\tx.txt\0")).toThrow(
      "has no --raw record",
    );
  });
});
