import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_WAIT_FLOOR_MS,
  installFsAwait,
  installFsCallGuard,
  installFsWaitMeter,
  onSlowFsCall,
  readFile,
  readFileSync,
  scanGlob,
  scanGlobSync,
  stat,
  statSync,
  type SlowFsCall,
} from "./timed-fs";

const dir = mkdtempSync(join(tmpdir(), "timed-fs-"));
writeFileSync(join(dir, "a.txt"), "hello");
writeFileSync(join(dir, "b.txt"), "world");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A disk that answers every call FS_WAIT_FLOOR_MS + 20 ms late. The call's own
// promise is handled at once (allSettled): a rejection left unhandled while the
// sleep runs is an unhandled rejection, which bun charges to the running test.
const stall = <T>(p: Promise<T>): Promise<T> =>
  Promise.allSettled([p, sleep(FS_WAIT_FLOOR_MS + 20)]).then(([r]) =>
    r!.status === "fulfilled" ? r!.value : Promise.reject(r!.reason as Error),
  );

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
  // Awaited by hand, so the timing assertion below runs after it settled.
  // Bun's message is "No such file or directory"; the errno is on `code`.
  const err: unknown = await readFile(join(dir, "missing")).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toMatchObject({ code: "ENOENT" });
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

test("an installed call guard sees every call first, and its throw refuses the call at once", () => {
  const calls: string[] = [];
  installFsCallGuard((op, target) => {
    calls.push(`${op} ${target}`);
    if (op !== "statSync") throw new Error(`refused ${op}`);
  });
  try {
    expect(statSync(join(dir, "a.txt")).size).toBe(5);
    expect(() => readFileSync(join(dir, "a.txt"))).toThrow(
      "refused readFileSync",
    );
    // An async call throws at the call, before any promise exists.
    expect(() => readFile(join(dir, "a.txt"))).toThrow("refused readFile");
    expect(() => [...scanGlobSync("*.txt", dir)]).toThrow(
      "refused scanGlobSync",
    );
  } finally {
    installFsCallGuard(null);
  }
  expect(calls).toEqual([
    `statSync ${join(dir, "a.txt")}`,
    `readFileSync ${join(dir, "a.txt")}`,
    `readFile ${join(dir, "a.txt")}`,
    `scanGlobSync ${dir}/*.txt`,
  ]);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello");
});

test("the wait meter sees every call while it runs: started before the disk answers, ended after", async () => {
  const log: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  installFsAwait((p) => held.then(() => p));
  installFsWaitMeter((layer) => {
    log.push(`start ${layer}`);
    return () => log.push(`end ${layer}`);
  });
  try {
    const pending = stat(join(dir, "a.txt"));
    // In progress: started, not ended — what a hung call looks like.
    expect(log).toEqual(["start fs-stat"]);
    release();
    await pending;
    statSync(join(dir, "a.txt"));
    const hits: string[] = [];
    for await (const rel of scanGlob("*.txt", { cwd: dir })) hits.push(rel);
    expect(log.slice(0, 4)).toEqual([
      "start fs-stat",
      "end fs-stat",
      "start fs-stat",
      "end fs-stat",
    ]);
    // Each glob step is its own call.
    expect(
      log
        .slice(4)
        .every((l, i) => l === (i % 2 ? "end fs-glob" : "start fs-glob")),
    ).toBe(true);
    expect(log.length).toBeGreaterThan(4);
  } finally {
    installFsWaitMeter(null);
  }
});

test("a file call the meter's own end makes is not metered again", () => {
  let starts = 0;
  installFsWaitMeter(() => {
    starts++;
    return () => void statSync(join(dir, "a.txt"));
  });
  try {
    statSync(join(dir, "b.txt"));
    expect(starts).toBe(1);
  } finally {
    installFsWaitMeter(null);
  }
});
