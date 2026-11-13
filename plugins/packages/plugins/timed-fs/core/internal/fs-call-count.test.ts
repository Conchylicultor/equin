import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fsCallPrefix,
  fsCallsSince,
  newFsCallTally,
  snapshotFsCalls,
  summarizeFsCalls,
  sharedFsCallTallies,
  withFsCallTally,
  withSharedFsWork,
} from "./fs-call-count";
import {
  readFile,
  readdirSync,
  scanGlobSync,
  stat,
  statSync,
} from "./timed-fs";

const dir = mkdtempSync(join(tmpdir(), "fs-call-count-"));
writeFileSync(join(dir, "a.txt"), "hello");

test("a span reads the process's calls made in between, by layer", async () => {
  const since = snapshotFsCalls();
  statSync(join(dir, "a.txt"));
  await stat(join(dir, "a.txt"));
  await readFile(join(dir, "a.txt"));
  readdirSync(dir);
  for (const _ of scanGlobSync("*.txt", dir)) void _;
  const s = fsCallsSince(since);
  expect([s.stat, s.read, s.readdir, s.glob, s.total]).toEqual([2, 1, 1, 1, 5]);
  expect(s.top).toEqual([]); // too few calls to name a prefix
});

test("a scope counts only its own async context, nested scopes count into both", async () => {
  const outer = newFsCallTally();
  const inner = newFsCallTally();
  const other = newFsCallTally();
  const a = withFsCallTally(outer, async () => {
    await stat(dir);
    await withFsCallTally(inner, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await stat(dir);
    });
  });
  const b = withFsCallTally(other, async () => {
    await readFile(join(dir, "a.txt"));
    await readFile(join(dir, "a.txt"));
  });
  await Promise.all([a, b]);
  expect(summarizeFsCalls(outer).total).toBe(2);
  expect(summarizeFsCalls(inner).total).toBe(1);
  expect(summarizeFsCalls(other)).toMatchObject({ read: 2, total: 2 });
});

test("shared work counts into its own tally and into no enclosing scope, whoever starts it", async () => {
  const first = newFsCallTally();
  const second = newFsCallTally();
  let memo: Promise<void> | null = null;
  // A per-process memo: whichever unit asks first starts the work.
  const shared = () =>
    (memo ??= withSharedFsWork("test-memo", async () => {
      await readFile(join(dir, "a.txt"));
      await readFile(join(dir, "a.txt"));
    }));
  await withFsCallTally(first, async () => {
    await shared();
    await stat(dir);
  });
  await withFsCallTally(second, async () => {
    await shared();
    await stat(dir);
  });
  // Both units made the same own call, so they count the same.
  expect(summarizeFsCalls(first)).toMatchObject({ read: 0, stat: 1, total: 1 });
  expect(summarizeFsCalls(second)).toMatchObject({
    read: 0,
    stat: 1,
    total: 1,
  });
  expect(
    summarizeFsCalls(sharedFsCallTallies().get("test-memo")!),
  ).toMatchObject({ read: 2, total: 2 });
});

test("a prefix keeps the first three directories under its base, never the file", () => {
  expect(fsCallPrefix(`${process.env.HOME}/cache/kind/ab/cd/x.json`)).toBe(
    "~/cache/kind/ab",
  );
  expect(fsCallPrefix(join(process.cwd(), "src/a/b/c/x.ts"))).toBe("./src/a/b");
  expect(fsCallPrefix("package.json")).toBe(".");
  expect(fsCallPrefix("/etc/hosts")).toBe("/etc");
  expect(fsCallPrefix(3)).toBe("(fd)");
});
