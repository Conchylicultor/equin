import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_SCHEMA_VERSION,
  flushArchive,
  loadArchive,
  mergeLive,
  UNDATED_SHARD_KEY,
  type ArchiveConvMeta,
  type ArchiveEntry,
} from "./archive";
import type { FilePartial } from "./usage-index";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REPO = "myrepo";
const REPO_DIR = "-Users-x-dev-myrepo";
const OTHER_DIR = "-Users-x-dev-something-else";

// `dayBuckets: []` on purpose — the archive never reads inside a bucket, and an
// empty array typechecks across the bucket reshape landing in `usage-index.ts`.
function partial(over: Partial<FilePartial> = {}): FilePartial {
  return {
    sessionId: "session-a",
    projectDir: REPO_DIR,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    lastActivity: "2026-08-06",
    // A deliberately synthetic id: the archive is model-agnostic — it stores and
    // merges whatever `parseTranscript` recorded and never resolves a price — so
    // a real model name here would imply a coupling that does not exist.
    modelsUsed: ["fixture-model"],
    dayBuckets: [],
    ...over,
  };
}

function entry(over: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    partial: partial(),
    title: "A title",
    conversationId: "conv-1",
    isRepo: true,
    ...over,
  };
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cost-archive-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function shard(dir: string, key: string): string {
  return join(dir, `sessions-${key}.json`);
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see the
 * retention / host-semaphore suites' identical helper), so this asserts the
 * rejection for real and hands back the error to pin its message.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const NO_META = new Map<string, ArchiveConvMeta>();

// ─── Round trip ──────────────────────────────────────────────────────────────

test("flush then load returns an equal map", async () => {
  const dir = await tempDir();
  const map = new Map<string, ArchiveEntry>([
    ["/p/a.jsonl", entry()],
    [
      "/p/b.jsonl",
      entry({
        partial: partial({ sessionId: "session-b", totalTokens: 7, projectDir: OTHER_DIR }),
        title: null,
        conversationId: null,
        isRepo: false,
      }),
    ],
  ]);

  await flushArchive(dir, map);
  expect(await loadArchive(dir)).toEqual(map);
});

test("an absent directory loads as an empty map, without throwing", async () => {
  const dir = await tempDir();
  expect(await loadArchive(join(dir, "does-not-exist"))).toEqual(new Map());
});

test("a directory with no shards loads as an empty map", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "index.json"), "{}", "utf8");
  expect(await loadArchive(dir)).toEqual(new Map());
});

// ─── The regression this whole module exists to prevent ──────────────────────

test("a path in the archive and absent from live survives merge + flush", async () => {
  const dir = await tempDir();
  const deleted = "/p/deleted-by-claude-gc.jsonl";
  await flushArchive(
    dir,
    new Map([
      [deleted, entry({ partial: partial({ sessionId: "gone", totalTokens: 5_000 }) })],
      ["/p/still-here.jsonl", entry({ partial: partial({ sessionId: "here" }) })],
    ]),
  );

  // The live corpus has forgotten the deleted transcript entirely.
  const archive = await loadArchive(dir);
  const live = new Map([["/p/still-here.jsonl", partial({ sessionId: "here" })]]);
  const { merged } = mergeLive(archive, live, NO_META, REPO);
  await flushArchive(dir, merged);

  const reloaded = await loadArchive(dir);
  expect(reloaded.has(deleted)).toBe(true);
  expect(reloaded.get(deleted)?.partial.totalTokens).toBe(5_000);
  expect(reloaded.size).toBe(2);
});

// ─── Version tolerance ───────────────────────────────────────────────────────

test("an unknown/newer schemaVersion survives load → merge → flush unchanged", async () => {
  const dir = await tempDir();
  const path = "/p/from-the-future.jsonl";
  const future = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION + 41,
    partial: partial({ sessionId: "future" }),
    title: "Written by a newer binary",
    conversationId: "conv-future",
    isRepo: true,
    // A field this version knows nothing about — dropping it would be data loss.
    someFutureField: { nested: [1, 2, 3] },
  };
  await writeFile(shard(dir, "2026"), JSON.stringify({ [path]: future }), "utf8");

  const archive = await loadArchive(dir);
  expect(archive.get(path)).toEqual(future as unknown as ArchiveEntry);

  // Not present in live, so it must pass through the merge untouched too.
  const { merged } = mergeLive(archive, new Map(), NO_META, REPO);
  await flushArchive(dir, merged);

  const onDisk: unknown = JSON.parse(await readFile(shard(dir, "2026"), "utf8"));
  expect(onDisk).toEqual({ [path]: future });
});

test("an entry missing optional fields loads with defaults rather than being dropped", async () => {
  const dir = await tempDir();
  const path = "/p/ancient.jsonl";
  await writeFile(
    shard(dir, "2026"),
    JSON.stringify({ [path]: { partial: partial({ sessionId: "ancient" }) } }),
    "utf8",
  );

  const loaded = await loadArchive(dir);
  expect(loaded.get(path)).toEqual({
    schemaVersion: 0,
    partial: partial({ sessionId: "ancient" }),
    title: null,
    conversationId: null,
    isRepo: false,
  });
});

// ─── Corruption is loud ──────────────────────────────────────────────────────

test("a corrupt shard throws instead of loading as empty", async () => {
  const dir = await tempDir();
  await writeFile(shard(dir, "2026"), '{"/p/a.jsonl": {"partial": {', "utf8");
  expect((await rejection(loadArchive(dir))).message).toMatch(/Corrupt cost archive shard/);
});

test("a shard whose root is not an object throws", async () => {
  const dir = await tempDir();
  await writeFile(shard(dir, "2026"), "[1,2,3]", "utf8");
  expect((await rejection(loadArchive(dir))).message).toMatch(/expected a JSON object/);
});

test("an entry without a partial throws", async () => {
  const dir = await tempDir();
  await writeFile(shard(dir, "2026"), JSON.stringify({ "/p/a.jsonl": { title: "x" } }), "utf8");
  expect((await rejection(loadArchive(dir))).message).toMatch(/no usable "partial"/);
});

// ─── Sharding ────────────────────────────────────────────────────────────────

test("entries spanning two years land in two distinct shards", async () => {
  const dir = await tempDir();
  await flushArchive(
    dir,
    new Map([
      ["/p/old.jsonl", entry({ partial: partial({ sessionId: "old", lastActivity: "2025-12-31" }) })],
      ["/p/new.jsonl", entry({ partial: partial({ sessionId: "new", lastActivity: "2026-01-01" }) })],
    ]),
  );

  const y2025: unknown = JSON.parse(await readFile(shard(dir, "2025"), "utf8"));
  const y2026: unknown = JSON.parse(await readFile(shard(dir, "2026"), "utf8"));
  expect(Object.keys(y2025 as object)).toEqual(["/p/old.jsonl"]);
  expect(Object.keys(y2026 as object)).toEqual(["/p/new.jsonl"]);
});

test("an entry with no usable lastActivity lands in the undated shard, never dropped", async () => {
  const dir = await tempDir();
  const map = new Map([
    ["/p/blank.jsonl", entry({ partial: partial({ sessionId: "blank", lastActivity: "" }) })],
    ["/p/junk.jsonl", entry({ partial: partial({ sessionId: "junk", lastActivity: "not-a-date" }) })],
  ]);
  await flushArchive(dir, map);

  const undated: unknown = JSON.parse(await readFile(shard(dir, UNDATED_SHARD_KEY), "utf8"));
  expect(Object.keys(undated as object).sort()).toEqual(["/p/blank.jsonl", "/p/junk.jsonl"]);
  expect(await loadArchive(dir)).toEqual(map);
});

test("only the touched shard is rewritten", async () => {
  const dir = await tempDir();
  const oldPath = "/p/old.jsonl";
  const newPath = "/p/new.jsonl";
  await flushArchive(
    dir,
    new Map([
      [oldPath, entry({ partial: partial({ sessionId: "old", lastActivity: "2025-06-01" }) })],
      [newPath, entry({ partial: partial({ sessionId: "new", lastActivity: "2026-06-01" }) })],
    ]),
  );
  const before2025 = (await stat(shard(dir, "2025"))).mtimeMs;
  const before2026 = (await stat(shard(dir, "2026"))).mtimeMs;
  await Bun.sleep(20);

  // Only the 2026 session gained tokens.
  const archive = await loadArchive(dir);
  const live = new Map([
    [newPath, partial({ sessionId: "new", lastActivity: "2026-06-02", totalTokens: 999 })],
  ]);
  const { merged } = mergeLive(archive, live, NO_META, REPO);
  const { written } = await flushArchive(dir, merged);

  expect(written).toEqual([shard(dir, "2026")]);
  expect((await stat(shard(dir, "2025"))).mtimeMs).toBe(before2025);
  expect((await stat(shard(dir, "2026"))).mtimeMs).not.toBe(before2026);
});

test("a flush that changes nothing writes nothing", async () => {
  const dir = await tempDir();
  const map = new Map([["/p/a.jsonl", entry()]]);
  await flushArchive(dir, map);
  expect((await flushArchive(dir, map)).written).toEqual([]);
});

// ─── Merge semantics ─────────────────────────────────────────────────────────

test("a live partial with fewer tokens does not clobber the archived one, and is surfaced", async () => {
  const path = "/p/truncated.jsonl";
  const archive = new Map([
    [path, entry({ partial: partial({ sessionId: "trunc", totalTokens: 10_000 }) })],
  ]);
  const live = new Map([[path, partial({ sessionId: "trunc", totalTokens: 42 })]]);

  const { merged, shrunk } = mergeLive(archive, live, NO_META, REPO);

  expect(merged.get(path)?.partial.totalTokens).toBe(10_000);
  expect(shrunk).toEqual([
    { path, sessionId: "trunc", archivedTotalTokens: 10_000, liveTotalTokens: 42 },
  ]);
});

test("a live partial that grew wins, and reports no shrink", async () => {
  const path = "/p/growing.jsonl";
  const archive = new Map([
    [path, entry({ partial: partial({ sessionId: "grow", totalTokens: 100 }) })],
  ]);
  const live = new Map([[path, partial({ sessionId: "grow", totalTokens: 250 })]]);

  const { merged, shrunk } = mergeLive(archive, live, NO_META, REPO);

  expect(merged.get(path)?.partial.totalTokens).toBe(250);
  expect(merged.get(path)?.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  expect(shrunk).toEqual([]);
});

test("a stored non-null title is not overwritten by a null from meta", async () => {
  const path = "/p/titled.jsonl";
  const archive = new Map([
    [path, entry({ partial: partial({ sessionId: "s" }), title: "Snapshotted title" })],
  ]);
  const live = new Map([[path, partial({ sessionId: "s", totalTokens: 200 })]]);
  // The conversation row survives but its title has been cleared / never set.
  const meta = new Map([["s", { conversationId: "conv-live", title: null }]]);

  const { merged } = mergeLive(archive, live, meta, REPO);

  expect(merged.get(path)?.title).toBe("Snapshotted title");
  expect(merged.get(path)?.conversationId).toBe("conv-live");
});

test("fresh non-null meta wins over the stored snapshot", async () => {
  const path = "/p/renamed.jsonl";
  const archive = new Map([[path, entry({ partial: partial({ sessionId: "s" }), title: "Old" })]]);
  const live = new Map([[path, partial({ sessionId: "s", totalTokens: 200 })]]);
  const meta = new Map([["s", { conversationId: "conv-2", title: "New" }]]);

  const { merged } = mergeLive(archive, live, meta, REPO);

  expect(merged.get(path)?.title).toBe("New");
  expect(merged.get(path)?.conversationId).toBe("conv-2");
});

test("isRepo is snapshotted per entry from the live project dir", async () => {
  const archive = new Map<string, ArchiveEntry>();
  const live = new Map([
    ["/p/main.jsonl", partial({ sessionId: "m", projectDir: REPO_DIR })],
    [
      "/p/worktree.jsonl",
      partial({
        sessionId: "w",
        projectDir: `${REPO_DIR}--claude-worktrees-att-1`,
      }),
    ],
    ["/p/other.jsonl", partial({ sessionId: "o", projectDir: OTHER_DIR })],
  ]);

  const { merged } = mergeLive(archive, live, NO_META, REPO);

  expect(merged.get("/p/main.jsonl")?.isRepo).toBe(true);
  expect(merged.get("/p/worktree.jsonl")?.isRepo).toBe(true);
  expect(merged.get("/p/other.jsonl")?.isRepo).toBe(false);
});

test("an archive-only entry keeps its snapshotted isRepo after a repo rename", async () => {
  const path = "/p/archived.jsonl";
  const archive = new Map([[path, entry({ isRepo: true })]]);
  // The repo has been renamed; nothing in the archive matches the new basename.
  const { merged } = mergeLive(archive, new Map(), NO_META, "renamed-repo");
  expect(merged.get(path)?.isRepo).toBe(true);
});

test("an entry that crosses into a new year leaves no stale duplicate behind", async () => {
  const dir = await tempDir();
  const path = "/p/resumed.jsonl";
  await flushArchive(
    dir,
    new Map([[path, entry({ partial: partial({ sessionId: "r", lastActivity: "2025-12-31" }) })]]),
  );

  const archive = await loadArchive(dir);
  const live = new Map([
    [path, partial({ sessionId: "r", lastActivity: "2026-01-01", totalTokens: 500 })],
  ]);
  const { merged } = mergeLive(archive, live, NO_META, REPO);
  await flushArchive(dir, merged);

  const reloaded = await loadArchive(dir);
  expect(reloaded.size).toBe(1);
  expect(reloaded.get(path)?.partial.lastActivity).toBe("2026-01-01");
  expect(JSON.parse(await readFile(shard(dir, "2025"), "utf8"))).toEqual({});
});
