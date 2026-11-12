import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  createMemoryRecordStore,
  gitBlobId,
  NO_OUTSIDE_FILES,
  type RecordStore,
  type RecordTable,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { evaluateBarrels, type BarrelRef } from "./evaluate";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

// The real slot-site tracker, imported by the fixtures by absolute path so a
// fixture's slot is recorded by the very module the evaluator reads.
const DECLARATION = realpathSync(
  join(
    import.meta.dir,
    "../../../../../../framework/plugins/slot-declaration/core/declaration.ts",
  ),
);

// The file-facts scan, as a checkout holds it: every graph keys its facts by
// this module's Merkle key, so a fixture set carries the real one.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN = readFileSync(
  join(import.meta.dir, "../../../core/internal/scan-imports.ts"),
  "utf8",
);

// The evaluator's own modules must be members of the set (its key is their
// Merkle key); their content is not what this test is about.
const EVALUATOR = {
  [SCAN_PATH]: SCAN,
  "plugins/plugin-meta/plugins/plugin-records/plugins/evaluate/core/evaluate.ts":
    "export {};",
  "plugins/plugin-meta/plugins/barrel-import/core/index.ts": "export {};",
};

const slotModule = (kind: string) =>
  `import { recordCreatedSlot } from ${JSON.stringify(DECLARATION)};\n` +
  `const s = Object.assign(() => {}, { meta: { kind: ${JSON.stringify(kind)} }, useContributions: () => [] });\n` +
  `recordCreatedSlot(s);\nexport const S = s;\n`;

// On disk: what the evaluator imports. Plugin a creates a slot, b imports a's
// slot module, c is unrelated.
const disk: Record<string, string> = {
  [`${P}/a/web/index.ts`]:
    'import { S } from "./slots";\nexport default { id: "a" };\nexport { S };\n',
  [`${P}/a/web/slots.ts`]: slotModule("render"),
  [`${P}/b/web/index.ts`]:
    'import { S } from "../../a/web/slots";\nexport default { id: "b", s: S };\n',
  [`${P}/c/web/index.ts`]: 'export default { id: "c" };\n',
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "evaluate-test-")));
for (const [p, c] of Object.entries(disk)) {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), c);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The set as keys see it: the disk's files, with `edits` applied. */
function snapshotOf(edits: Record<string, string> = {}): RepoSnapshot {
  const files: Record<string, string> = { ...EVALUATOR, ...disk, ...edits };
  const paths = Object.keys(files).sort();
  return {
    root: asAppPath(root),
    all: () => paths,
    has: (p) => p in files,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => Promise.resolve(files[p] ?? null),
    blobOf: (p) => {
      const c = files[p];
      if (c === undefined) throw new Error(`not a member: ${p}`);
      return gitBlobId(c);
    },
  };
}

/** A store that counts the keys each table is asked to write. */
function countingStore(): {
  store: RecordStore;
  minted: Map<RecordTable, number>;
} {
  const inner = createMemoryRecordStore();
  const minted = new Map<RecordTable, number>();
  const store: RecordStore = Object.create(inner) as RecordStore;
  store.putMany = (table, entries) => {
    const list = [...entries];
    minted.set(table, (minted.get(table) ?? 0) + list.length);
    inner.putMany(table, list);
  };
  return { store, minted };
}

/**
 * The keys an evaluation minted, by table — without the module graph's own
 * file facts (the `file` / `group` tables), which a changed blob mints
 * whoever reads the graph.
 */
const evaluationMinted = (minted: Map<RecordTable, number>) =>
  Object.fromEntries(
    [...minted].filter(([t]) => t !== "file" && t !== "group"),
  );

const ref = (p: string): BarrelRef => ({
  path: `${P}/${p}/web/index.ts`,
  pluginId: p,
  runtime: "web",
});
const barrels = ["a", "b", "c"].map(ref);

async function evaluate(store: RecordStore, edits?: Record<string, string>) {
  return evaluateBarrels(
    {
      snapshot: snapshotOf(edits),
      store,
      readOutside: NO_OUTSIDE_FILES,
      realRoot: root,
    },
    barrels,
  );
}

describe("evaluateBarrels — module facts ride on the barrel's record", () => {
  const { store, minted } = countingStore();

  test("a cold evaluation mints one evaluated record per barrel and nothing per module", async () => {
    const ev = await evaluate(store);
    expect(ev.imported).toBe(3);
    expect(evaluationMinted(minted)).toEqual({ evaluated: 3 });
    const slots = ev.createdSlots([ref("a").path]);
    expect(slots.map((s) => s.identity)).toEqual([`${P}/a/web/slots.ts#0`]);
    expect(slots[0]!.meta.kind).toBe("render");
    // Two barrels over one module: its slot once.
    expect(
      ev.createdSlots(barrels.map((b) => b.path)).map((s) => s.identity),
    ).toEqual([`${P}/a/web/slots.ts#0`]);
    expect(ev.createdSlots([ref("c").path])).toEqual([]);
  });

  test("a warm evaluation imports nothing and reads the same slots from the records", async () => {
    minted.clear();
    const ev = await evaluate(store);
    expect(ev.imported).toBe(0);
    expect(evaluationMinted(minted)).toEqual({});
    expect(
      ev.createdSlots(barrels.map((b) => b.path)).map((s) => s.identity),
    ).toEqual([`${P}/a/web/slots.ts#0`]);
  });

  test("a change to a module in a barrel's closure re-keys exactly the barrels above it", async () => {
    minted.clear();
    const ev = await evaluate(store, {
      [`${P}/a/web/slots.ts`]: `${disk[`${P}/a/web/slots.ts`]}// edited\n`,
    });
    expect(ev.imported).toBe(2);
    expect(evaluationMinted(minted)).toEqual({ evaluated: 2 });
  });

  test("a change outside every closure re-keys nothing it does not read", async () => {
    minted.clear();
    const ev = await evaluate(store, {
      [`${P}/c/web/index.ts`]: `${disk[`${P}/c/web/index.ts`]}// edited\n`,
    });
    expect(ev.imported).toBe(1);
    expect(evaluationMinted(minted)).toEqual({ evaluated: 1 });
    minted.clear();
    const unrelated = await evaluate(store, {
      [`${P}/d/core/index.ts`]: "export {};",
    });
    expect(unrelated.imported).toBe(0);
    expect(evaluationMinted(minted)).toEqual({});
  });
});
