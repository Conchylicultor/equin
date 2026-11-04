import { beforeAll, describe, expect, test } from "bun:test";
import {
  MIGRATIONS_DATA_DIR,
  schemaFilesIn,
  schemaGlobFiles,
} from "@plugins/database/plugins/migrations/core";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { createMemoryRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { drizzleVerdictKey } from "./drizzle-verdict";

// The checkout's own snapshot, with one file's blob id swapped: what the key
// sees after an edit to it, without editing anything.
function withBlob(
  snapshot: RepoSnapshot,
  path: string,
  blob: string,
): RepoSnapshot {
  if (!snapshot.has(path)) throw new Error(`${path} is not in the snapshot`);
  return {
    ...snapshot,
    blobOf: (p) => (p === path ? blob : snapshot.blobOf(p)),
  };
}

// A file set with one extra member (a new schema file).
function withFile(snapshot: RepoSnapshot, path: string): RepoSnapshot {
  const all = [...snapshot.all(), path].sort();
  return {
    ...snapshot,
    all: () => all,
    has: (p) => p === path || snapshot.has(p),
    under: (dir) =>
      [
        ...snapshot.under(dir),
        ...(path.startsWith(`${dir}/`) ? [path] : []),
      ].sort(),
    read: (p) =>
      p === path ? Promise.resolve("export {};\n") : snapshot.read(p),
    blobOf: (p) => (p === path ? "f".repeat(40) : snapshot.blobOf(p)),
  };
}

const store = createMemoryRecordStore();
let snapshot: RepoSnapshot;
let base: string;
let schema: string[];

beforeAll(async () => {
  snapshot = await loadRepoSnapshot(await getWorktreeRoot());
  schema = schemaFilesIn(snapshot);
  base = (await drizzleVerdictKey(snapshot, store)).key;
});

const OTHER_BLOB = "0".repeat(40);

describe("drizzleVerdictKey", () => {
  test("the snapshot's schema files are the ones drizzle-kit globs", async () => {
    expect(schema).toEqual(await schemaGlobFiles(snapshot.root));
  });

  test("is stable for the same inputs", async () => {
    expect((await drizzleVerdictKey(snapshot, store)).key).toBe(base);
  });

  test("moves with a schema file", async () => {
    const s = withBlob(snapshot, schema[0]!, OTHER_BLOB);
    expect((await drizzleVerdictKey(s, store)).key).not.toBe(base);
  });

  test("moves with the tip snapshot and the journal", async () => {
    for (const f of ["schema.snapshot.json", "_journal.json"]) {
      const s = withBlob(
        snapshot,
        `${MIGRATIONS_DATA_DIR}/meta/${f}`,
        OTHER_BLOB,
      );
      expect((await drizzleVerdictKey(s, store)).key).not.toBe(base);
    }
  });

  test("moves with the lockfile and the drizzle config", async () => {
    for (const f of [
      "bun.lock",
      "plugins/database/plugins/migrations/core/drizzle.config.ts",
    ]) {
      const s = withBlob(snapshot, f, OTHER_BLOB);
      expect((await drizzleVerdictKey(s, store)).key).not.toBe(base);
    }
  });

  test("moves with a new schema file, and nothing else", async () => {
    const s = withFile(
      snapshot,
      "plugins/database/plugins/migrations/server/internal/tables-verdict-probe.ts",
    );
    expect((await drizzleVerdictKey(s, store)).key).not.toBe(base);
  });

  test("does not move with a file outside every schema closure", async () => {
    const s = withBlob(
      snapshot,
      "plugins/apps/plugins/keyboard-party/plugins/party/web/index.ts",
      OTHER_BLOB,
    );
    expect((await drizzleVerdictKey(s, store)).key).toBe(base);
  });
});
