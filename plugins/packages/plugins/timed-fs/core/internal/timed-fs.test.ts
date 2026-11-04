import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_WAIT_FLOOR_MS,
  installFsAwait,
  onSlowFsCall,
  readFile,
  scanGlob,
  stat,
  statSync,
  type SlowFsCall,
} from "./timed-fs";

const dir = mkdtempSync(join(tmpdir(), "timed-fs-"));
writeFileSync(join(dir, "a.txt"), "hello");
writeFileSync(join(dir, "b.txt"), "world");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A disk that answers every call FS_WAIT_FLOOR_MS + 20 ms late.
const stall = <T>(p: Promise<T>): Promise<T> =>
  sleep(FS_WAIT_FLOOR_MS + 20).then(() => p);

const seen: SlowFsCall[] = [];
const off = onSlowFsCall((c) => seen.push(c));

afterEach(() => {
  installFsAwait((p) => p);
  seen.length = 0;
});

test("a fast call is not handed on, and keeps node's answer", async () => {
  expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello");
  expect(statSync(join(dir, "a.txt")).size).toBe(5);
  expect(seen).toEqual([]);
});

test("a call past the floor is handed on with its layer, op and target", async () => {
  installFsAwait(stall);
  const s = await stat(join(dir, "a.txt"));
  expect(s.isFile()).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    layer: "fs-stat",
    op: "stat",
    target: join(dir, "a.txt"),
  });
  expect(seen[0]!.ms).toBeGreaterThanOrEqual(FS_WAIT_FLOOR_MS);
});

test("a failing call still rejects with node's error, and is still timed", async () => {
  installFsAwait(stall);
  expect(readFile(join(dir, "missing"))).rejects.toThrow("ENOENT");
  await sleep(FS_WAIT_FLOOR_MS + 60);
  expect(seen.map((c) => c.layer)).toEqual(["fs-read"]);
});

test("a scan is one fs-glob call summing its steps, and lists what Bun.Glob does", async () => {
  installFsAwait(stall);
  const hits: string[] = [];
  for await (const rel of scanGlob("*.txt", { cwd: dir })) hits.push(rel);
  expect(hits.sort()).toEqual(["a.txt", "b.txt"]);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ layer: "fs-glob", target: `${dir}/*.txt` });
});

test("a scan broken out of early is still handed on", async () => {
  installFsAwait(stall);
  for await (const _ of scanGlob("*.txt", dir)) break;
  expect(seen.map((c) => c.op)).toEqual(["scanGlob"]);
});

test("an unsubscribed handler hears nothing", async () => {
  off();
  installFsAwait(stall);
  await stat(dir);
  expect(seen).toEqual([]);
});
