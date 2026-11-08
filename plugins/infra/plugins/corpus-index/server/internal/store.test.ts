import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCorpusFile,
  recordCorpusChanges,
  recordCorpusCursors,
  saveCorpusSnapshot,
  type CorpusFile,
} from "./store";

let dir: string;
let indexPath: string;
const VERSION = "v1";

const entry = (partial: string) => ({ mtimeMs: 1, size: 1, partial });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-store-test-"));
  indexPath = join(dir, "index.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function snapshotText(): Promise<CorpusFile<string>> {
  return JSON.parse(await readFile(indexPath, "utf8")) as CorpusFile<string>;
}

async function logs(): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.endsWith(".log"));
}

test("a change after the first save appends to the log; the snapshot is untouched; a load replays it", async () => {
  const index: CorpusFile<string> = {
    version: VERSION,
    // A snapshot larger than the log this test appends, so it is not folded.
    files: {
      "/a": entry("a"),
      "/b": entry("b"),
      "/big": entry("x".repeat(4096)),
    },
  };
  // A document with no log yet: its first save is a snapshot.
  await recordCorpusChanges(indexPath, index, ["/a", "/b"], []);
  const snap = await readFile(indexPath, "utf8");

  index.files["/a"] = entry("a2");
  index.files["/c"] = entry("c");
  delete index.files["/b"];
  await recordCorpusChanges(indexPath, index, ["/a", "/c"], ["/b"]);
  expect(await readFile(indexPath, "utf8")).toBe(snap);
  expect(await logs()).toHaveLength(1);

  const loaded = await loadCorpusFile<string>(indexPath, VERSION);
  expect(loaded.files).toEqual({
    "/a": entry("a2"),
    "/big": entry("x".repeat(4096)),
    "/c": entry("c"),
  });

  // The loaded document goes on appending to the same log.
  loaded.files["/d"] = entry("d");
  await recordCorpusChanges(indexPath, loaded, ["/d"], []);
  expect(await readFile(indexPath, "utf8")).toBe(snap);
  expect(
    Object.keys((await loadCorpusFile<string>(indexPath, VERSION)).files),
  ).toEqual(["/a", "/big", "/c", "/d"]);
});

test("a log grown past its snapshot is folded into a new one, and the old log removed", async () => {
  const index: CorpusFile<string> = {
    version: VERSION,
    files: { "/a": entry("a") },
  };
  await saveCorpusSnapshot(indexPath, index);
  const firstGen = index.log;
  for (let i = 0; i < 10; i++) {
    index.files["/a"] = entry(`a${i}`);
    await recordCorpusChanges(indexPath, index, ["/a"], []);
  }
  expect(index.log).not.toBe(firstGen);
  expect((await snapshotText()).log).toBe(index.log);
  expect((await logs()).some((n) => n.includes(firstGen!))).toBe(false);
  expect(
    (await loadCorpusFile<string>(indexPath, VERSION)).files["/a"],
  ).toEqual(entry("a9"));
});

test("a log of another generation is never replayed; a torn last line is skipped", async () => {
  const index: CorpusFile<string> = {
    version: VERSION,
    files: { "/a": entry("a") },
  };
  await saveCorpusSnapshot(indexPath, index);
  // A crash left an older generation's log behind.
  await writeFile(
    `${indexPath}.old-1.log`,
    `${JSON.stringify({ p: "/a", e: entry("stale") })}\n`,
  );
  // The current log: one complete record, then one cut mid-write.
  await appendFile(
    `${indexPath}.${index.log}.log`,
    `${JSON.stringify({ p: "/b", e: entry("b") })}\n{"p":"/c","e":`,
  );
  const loaded = await loadCorpusFile<string>(indexPath, VERSION);
  expect(loaded.files).toEqual({ "/a": entry("a"), "/b": entry("b") });
});

test("a corrupt complete log line means a rebuild, like a corrupt snapshot", async () => {
  const index: CorpusFile<string> = {
    version: VERSION,
    files: { "/a": entry("a") },
  };
  await saveCorpusSnapshot(indexPath, index);
  await appendFile(`${indexPath}.${index.log}.log`, "not json\n");
  expect((await loadCorpusFile<string>(indexPath, VERSION)).files).toEqual({});
});

test("a snapshot from before the log (no generation) loads, and its first save is a snapshot", async () => {
  await writeFile(
    indexPath,
    JSON.stringify({ version: VERSION, files: { "/a": entry("a") } }),
  );
  const loaded = await loadCorpusFile<string>(indexPath, VERSION);
  expect(loaded.files).toEqual({ "/a": entry("a") });
  loaded.files["/b"] = entry("b");
  await recordCorpusChanges(indexPath, loaded, ["/b"], []);
  expect(Object.keys((await snapshotText()).files)).toEqual(["/a", "/b"]);
});

test("a log cut mid-record is never appended to: the next save starts a clean one", async () => {
  const index: CorpusFile<string> = {
    version: VERSION,
    files: { "/a": entry("a"), "/big": entry("x".repeat(4096)) },
  };
  await saveCorpusSnapshot(indexPath, index);
  await appendFile(
    `${indexPath}.${index.log}.log`,
    `${JSON.stringify({ p: "/b", e: entry("b") })}\n{"p":"/c","e":`,
  );
  const loaded = await loadCorpusFile<string>(indexPath, VERSION);
  loaded.files["/d"] = entry("d");
  await recordCorpusChanges(indexPath, loaded, ["/d"], []);
  expect(
    Object.keys(
      (await loadCorpusFile<string>(indexPath, VERSION)).files,
    ).sort(),
  ).toEqual(["/a", "/b", "/big", "/d"]);
  expect(await logs()).toHaveLength(0);
});

test("moving the cursors appends one log line; a load replays them over the snapshot's", async () => {
  const cursor = (root: string, eventId: string) => ({
    root,
    dev: 1,
    ino: 2,
    eventId,
    takenAt: 3,
    snapshot: `${eventId}\n4`,
  });
  const index: CorpusFile<string> = {
    version: VERSION,
    files: { "/a": entry("a"), "/big": entry("x".repeat(4096)) },
    cursors: [cursor("/r", "10")],
  };
  await saveCorpusSnapshot(indexPath, index);
  const snapshotBefore = await readFile(indexPath, "utf8");

  index.files["/b"] = entry("b");
  await recordCorpusChanges(indexPath, index, ["/b"], []);
  index.cursors = [cursor("/r", "20")];
  await recordCorpusCursors(indexPath, index);

  expect(await readFile(indexPath, "utf8")).toBe(snapshotBefore);
  const loaded = await loadCorpusFile<string>(indexPath, VERSION);
  expect(loaded.cursors).toEqual([cursor("/r", "20")]);
  expect(loaded.files["/b"]).toEqual(entry("b"));

  // No cursors any more: logged as such, and a load has none.
  delete loaded.cursors;
  await recordCorpusCursors(indexPath, loaded);
  expect(
    (await loadCorpusFile<string>(indexPath, VERSION)).cursors,
  ).toBeUndefined();
});
