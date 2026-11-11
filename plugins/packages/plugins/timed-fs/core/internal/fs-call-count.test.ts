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
  withFsCallTally,
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

test("a prefix keeps the first three directories under its base, never the file", () => {
  expect(fsCallPrefix(`${process.env.HOME}/cache/kind/ab/cd/x.json`)).toBe(
    "~/cache/kind/ab",
  );
  expect(fsCallPrefix(join(process.cwd(), "src/a/b/c/x.ts"))).toBe("./src/a/b");
  expect(fsCallPrefix("package.json")).toBe(".");
  expect(fsCallPrefix("/etc/hosts")).toBe("/etc");
  expect(fsCallPrefix(3)).toBe("(fd)");
});
