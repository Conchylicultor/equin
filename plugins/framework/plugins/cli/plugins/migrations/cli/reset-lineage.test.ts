import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderPhasedMigration } from "@plugins/database/plugins/migrations/core";
import { readResetPrior, resetLineage } from "./reset-lineage";

const NULL_ID = "00000000-0000-0000-0000-000000000000";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const BASE = "20260101_000000_0a0a0a0a__base";
const O1 = "20261020_110000_38bc8c97__add_c1";
const O2 = "20261020_114900_f09303fa__add_c2";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reset-lineage-"));
  mkdirSync(join(dir, "meta"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function snapshot(
  tag: string,
  id: string,
  prevId: string,
  tables: Record<string, string[]>,
): void {
  const body = {
    id,
    prevId,
    tables: Object.fromEntries(
      Object.entries(tables).map(([t, cols]) => [
        t,
        { columns: Object.fromEntries(cols.map((c) => [c, { type: "text" }])) },
      ]),
    ),
    _meta: { columns: {}, schemas: {}, tables: {} },
  };
  writeFileSync(
    join(dir, "meta", `${tag}_snapshot.json`),
    JSON.stringify(body),
  );
}

function migration(
  tag: string,
  supersedes: Parameters<typeof renderPhasedMigration>[0]["supersedes"] = null,
): void {
  writeFileSync(
    join(dir, `${tag}.sql`),
    renderPhasedMigration({
      expand: "SELECT 1;",
      contract: "",
      claims: [],
      supersedes,
    }),
  );
}

// The published base, and the branch's own o1 → o2 on top of it.
function branchHistory(): Set<string> {
  migration(BASE);
  snapshot(BASE, A, NULL_ID, { t: [] });
  migration(O1);
  snapshot(O1, B, A, { t: ["c1"] });
  migration(O2);
  snapshot(O2, C, B, { t: ["c1", "c2"] });
  return new Set([`${BASE}.sql`, `${BASE}_snapshot.json`]);
}

// What the reset does to disk: delete the branch's own files.
function reset(): void {
  for (const tag of [O1, O2]) {
    rmSync(join(dir, `${tag}.sql`));
    rmSync(join(dir, "meta", `${tag}_snapshot.json`));
  }
}

// drizzle-kit's fresh output, diffed against `prevId`.
function fresh(prevId: string, tables: Record<string, string[]>): string {
  writeFileSync(
    join(dir, "0002_merged.sql"),
    "ALTER TABLE t ADD COLUMN c1 text;",
  );
  snapshot("0002", D, prevId, tables);
  return join(dir, "meta", "0002_snapshot.json");
}

describe("reset lineage", () => {
  test("a regen of the same schema supersedes every deleted hash", async () => {
    const prior = readResetPrior(dir, branchHistory());
    expect(prior.deleted.map((d) => d.hash)).toEqual(["38bc8c97", "f09303fa"]);
    expect(prior.schema).toMatchObject({ kind: "known", baseId: A });
    reset();
    const lineage = await resetLineage(
      dir,
      prior,
      fresh(A, { t: ["c1", "c2"] }),
    );
    expect(lineage).toEqual({
      kind: "supersedes",
      supersedes: { direct: ["38bc8c97", "f09303fa"], inherited: [] },
    });
  });

  test("main moving under the branch still supersedes, through the 3-way merge", async () => {
    const published = branchHistory();
    const P1 = "20261020_113000_0b0b0b0b__main_adds_u";
    migration(P1);
    snapshot(P1, E, A, { t: [], u: [] });
    published.add(`${P1}.sql`);
    const prior = readResetPrior(dir, published);
    reset();
    const lineage = await resetLineage(
      dir,
      prior,
      fresh(E, { t: ["c1", "c2"], u: [] }),
    );
    expect(lineage.kind).toBe("supersedes");
  });

  test("schema.ts changed after the last generation: no header, and why", async () => {
    const prior = readResetPrior(dir, branchHistory());
    reset();
    const lineage = await resetLineage(
      dir,
      prior,
      fresh(A, { t: ["c1", "c2", "c3"] }),
    );
    expect(lineage).toEqual({
      kind: "none",
      reason: expect.stringContaining("schema.ts changed"),
    });
  });

  test("a deleted file's own lineage is inherited", async () => {
    migration(BASE);
    snapshot(BASE, A, NULL_ID, { t: [] });
    const M1 = "20261020_115443_a1a1a1a1__merged_1";
    migration(M1, { direct: ["38bc8c97", "f09303fa"], inherited: [] });
    snapshot(M1, B, A, { t: ["c1"] });
    const prior = readResetPrior(
      dir,
      new Set([`${BASE}.sql`, `${BASE}_snapshot.json`]),
    );
    rmSync(join(dir, `${M1}.sql`));
    rmSync(join(dir, "meta", `${M1}_snapshot.json`));
    const lineage = await resetLineage(dir, prior, fresh(A, { t: ["c1"] }));
    expect(lineage).toEqual({
      kind: "supersedes",
      supersedes: {
        direct: ["a1a1a1a1"],
        inherited: [{ hash: "a1a1a1a1", replaced: ["38bc8c97", "f09303fa"] }],
      },
    });
  });

  test("nothing branch-local: nothing to supersede, nothing to warn about", async () => {
    migration(BASE);
    snapshot(BASE, A, NULL_ID, { t: [] });
    const prior = readResetPrior(dir, new Set([`${BASE}.sql`]));
    expect(await resetLineage(dir, prior, fresh(A, { t: ["c1"] }))).toEqual({
      kind: "none",
      reason: null,
    });
  });
});
