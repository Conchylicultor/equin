import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCostArchive } from "./archive";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cost-archive-"));
  dirs.push(dir);
  return dir;
}

const bucket = {
  date: "2026-01-02",
  model: "claude-test",
  speed: "standard" as const,
  input: { below: 5, above: 0 },
  output: { below: 1, above: 0 },
  cacheRead: { below: 0, above: 0 },
  cacheCreate5m: { below: 0, above: 0 },
  cacheCreate1h: { below: 0, above: 0 },
};

describe("loadCostArchive", () => {
  test("reads every shard, keyed by transcript path, extra fields ignored", async () => {
    const dir = await newDir();
    await writeFile(
      join(dir, "sessions-2025.json"),
      JSON.stringify({
        "/p/a.jsonl": {
          schemaVersion: 1,
          partial: { sessionId: "a", totalTokens: 6, dayBuckets: [bucket] },
          title: "first",
          conversationId: "conv-a",
          isRepo: true,
        },
      }),
    );
    await writeFile(
      join(dir, "sessions-undated.json"),
      JSON.stringify({ "/p/b.jsonl": { partial: { dayBuckets: [] } } }),
    );
    // Not a shard: never read.
    await writeFile(join(dir, "index.json"), "not json");
    const archive = await loadCostArchive(dir);
    expect([...archive.keys()].sort()).toEqual(["/p/a.jsonl", "/p/b.jsonl"]);
    expect(archive.get("/p/a.jsonl")).toEqual({
      partial: { dayBuckets: [bucket] },
      title: "first",
      conversationId: "conv-a",
      isRepo: true,
    });
    // An entry written before a field existed reads it as unknown.
    expect(archive.get("/p/b.jsonl")).toEqual({
      partial: { dayBuckets: [] },
      title: null,
      conversationId: null,
      isRepo: false,
    });
  });

  test("an absent dir is an empty archive", async () => {
    const dir = await newDir();
    expect((await loadCostArchive(join(dir, "missing"))).size).toBe(0);
  });

  test("a corrupt shard throws, naming it — never an empty archive", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "sessions-2024.json"), "{ torn");
    expect(loadCostArchive(dir)).rejects.toThrow(/sessions-2024\.json/);
    await writeFile(
      join(dir, "sessions-2024.json"),
      JSON.stringify({ "/p/c.jsonl": { title: "no partial" } }),
    );
    expect(loadCostArchive(dir)).rejects.toThrow(/sessions-2024\.json/);
  });
});
