import { describe, expect, test } from "bun:test";
import {
  formatSnapshotConflict,
  mergeSnapshots,
  type Snapshot,
} from "./snapshot-merge";

const col = (type: string) => ({
  name: "c",
  type,
  primaryKey: false,
  notNull: false,
});

function snap(tables: Snapshot["tables"], extra: Snapshot = {}): Snapshot {
  return {
    id: "id",
    prevId: "prev",
    version: "7",
    dialect: "postgresql",
    tables,
    enums: {},
    _meta: { columns: {}, schemas: {}, tables: {} },
    ...extra,
  };
}

const table = (name: string, columns: Snapshot): Snapshot => ({
  [`public.${name}`]: { name, schema: "", columns },
});

describe("mergeSnapshots", () => {
  test("disjoint additions on both sides are both kept", () => {
    const base = snap({ ...table("a", {}) });
    const ours = snap({ ...table("a", {}), ...table("u", {}) });
    const theirs = snap({ ...table("a", {}), ...table("p", {}) });
    const r = mergeSnapshots(base, ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.merged.tables as object).sort()).toEqual([
      "public.a",
      "public.p",
      "public.u",
    ]);
  });

  test("a change on one side wins over the untouched other", () => {
    const base = snap(table("a", { c: col("text") }));
    const ours = snap(table("a", { c: col("text") }));
    const theirs = snap(table("a", { c: col("integer") }));
    const r = mergeSnapshots(base, ours, theirs);
    expect(r).toEqual({
      ok: true,
      merged: expect.objectContaining({
        tables: table("a", { c: col("integer") }),
      }),
    });
  });

  test("a delete on one side, untouched on the other, is a delete", () => {
    const base = snap({ ...table("a", {}), ...table("gone", {}) });
    const ours = snap({ ...table("a", {}) });
    const theirs = snap({ ...table("a", {}), ...table("gone", {}) });
    const r = mergeSnapshots(base, ours, theirs);
    expect(r.ok && Object.keys(r.merged.tables as object)).toEqual([
      "public.a",
    ]);
  });

  test("the same change to an existing key on both sides merges cleanly", () => {
    const base = snap(table("x", { c: col("text") }));
    const both = snap(table("x", { c: col("integer") }));
    expect(mergeSnapshots(base, both, both)).toEqual({
      ok: true,
      merged: expect.objectContaining({
        tables: table("x", { c: col("integer") }),
      }),
    });
  });

  // Each side's migrations carry their own DDL for a key they added, and it is
  // not idempotent: a second bare `ADD COLUMN` fails on the DB.
  test("an identical addition on both sides conflicts at the added key", () => {
    const base = snap(table("x", {}));
    const both = snap(table("x", { c: col("text") }));
    const r = mergeSnapshots(base, both, both);
    expect(!r.ok && r.conflicts.map((c) => c.path.join("."))).toEqual([
      "tables.public.x.columns.c",
    ]);
  });

  // `CREATE TABLE IF NOT EXISTS` makes the second side's table a no-op, so a
  // column only that side declared would silently never exist.
  test("both sides creating one table with different columns conflicts at each difference", () => {
    const base = snap({});
    const ours = snap(table("t", { a: col("text"), u: col("text") }));
    const theirs = snap(table("t", { a: col("text"), p: col("text") }));
    const r = mergeSnapshots(base, ours, theirs);
    expect(!r.ok && r.conflicts.map((c) => c.path.join("."))).toEqual([
      "tables.public.t.columns.u",
      "tables.public.t.columns.p",
    ]);
  });

  test("both sides adding the same column with different types conflicts at .type", () => {
    const base = snap(table("probe", { id: col("text") }));
    const ours = snap(
      table("probe", {
        id: col("text"),
        note: { ...col("integer"), name: "note" },
      }),
    );
    const theirs = snap(
      table("probe", {
        id: col("text"),
        note: { ...col("text"), name: "note" },
      }),
    );
    const r = mergeSnapshots(base, ours, theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.map(formatSnapshotConflict)).toEqual([
      "tables.public.probe.columns.note.type: ours=integer theirs=text base=<absent>",
    ]);
  });

  test("a delete on one side and a change on the other conflicts", () => {
    const base = snap(table("t", { c: col("text") }));
    const ours = snap({});
    const theirs = snap(table("t", { c: col("integer") }));
    const r = mergeSnapshots(base, ours, theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.map((c) => c.path.join("."))).toEqual([
      "tables.public.t",
    ]);
    expect(formatSnapshotConflict(r.conflicts[0]!)).toStartWith(
      "tables.public.t: ours=<absent> theirs={",
    );
  });

  test("arrays are leaves: differing edits conflict as a whole", () => {
    const base = snap({}, { roles: { r: { cols: ["a"] } } });
    const ours = snap({}, { roles: { r: { cols: ["a", "b"] } } });
    const theirs = snap({}, { roles: { r: { cols: ["a", "c"] } } });
    const r = mergeSnapshots(base, ours, theirs);
    expect(!r.ok && r.conflicts.map((c) => c.path.join("."))).toEqual([
      "roles.r.cols",
    ]);
  });

  test("id, prevId and _meta are never merged or conflicted", () => {
    const base = snap({}, { id: "b", prevId: "bp" });
    const ours = snap({}, { id: "o", prevId: "op", _meta: { x: 1 } });
    const theirs = snap({}, { id: "t", prevId: "tp", _meta: { y: 2 } });
    const r = mergeSnapshots(base, ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      "id" in r.merged || "prevId" in r.merged || "_meta" in r.merged,
    ).toBe(false);
  });
});
