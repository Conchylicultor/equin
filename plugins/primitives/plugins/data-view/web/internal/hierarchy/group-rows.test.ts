/**
 * Pure unit tests for the hierarchical views' group-by helpers: the buildTree orphan
 * rule (`projectedRoots`), the field adaptation onto the projected wrapper
 * (`fieldsForProjected`), and the children-follow-their-root bucketing
 * (`bucketRowsByRootSection`).
 * Run with `./singularity test plugins/primitives/plugins/data-view`.
 *
 * No DOM, no React render: all three are pure functions, so these are bun:test
 * (not the jsdom vitest suite). The shared `partitionIntoSections` itself is
 * covered by data-view's own suite; here its output shape is hand-built.
 */

import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { DataViewSection, FieldDef } from "../../../core";
import type { ProjectedRow } from "./project-rows";
import {
  bucketRowsByRootSection,
  fieldsForProjected,
  projectedRoots,
} from "./group-rows";

interface Row {
  id: string;
  status: string | null;
}

function proj(
  id: string,
  parentId: string | null,
  status: string | null = null,
): ProjectedRow<Row> {
  return {
    id,
    parentId,
    rank: Rank.from("a0"),
    expanded: false,
    alias: false,
    __row: { id, status },
  };
}

/** A hand-built root partition: one section per listed key, holding the given
 *  root rows — the shape `partitionIntoSections` returns. */
function sectionsOf(
  ...groups: [key: string, roots: ProjectedRow<Row>[]][]
): DataViewSection<ProjectedRow<Row>>[] {
  return groups.map(([key, roots]) => ({
    key,
    label: key,
    count: { kind: "exact", n: roots.length },
    entries: roots.map((p) => ({ row: p, key: p.id })),
  }));
}

describe("projectedRoots", () => {
  test("null-parent rows are roots", () => {
    const rows = [proj("a", null), proj("b", "a")];
    expect(projectedRoots(rows).map((p) => p.id)).toEqual(["a"]);
  });

  test("a row whose parent is absent from the set is a root (orphan rule)", () => {
    // "c" points at "missing" (filtered out) — buildTree renders it as a root.
    const rows = [proj("a", null), proj("b", "a"), proj("c", "missing")];
    expect(projectedRoots(rows).map((p) => p.id)).toEqual(["a", "c"]);
  });
});

describe("fieldsForProjected", () => {
  test("value unwraps the projected wrapper; identity members carry over", () => {
    const field: FieldDef<Row> = {
      id: "status",
      label: "Status",
      type: "enum",
      options: [{ value: "open", label: "Open" }],
      value: (r) => r.status,
    };
    const [adapted] = fieldsForProjected([field]);
    expect(adapted!.id).toBe("status");
    expect(adapted!.type).toBe("enum");
    expect(adapted!.options).toEqual([{ value: "open", label: "Open" }]);
    expect(adapted!.value!(proj("a", null, "open"))).toBe("open");
  });

  test("a value-less field stays value-less", () => {
    const [adapted] = fieldsForProjected<Row>([{ id: "x", label: "X" }]);
    expect(adapted!.value).toBeUndefined();
  });
});

describe("bucketRowsByRootSection", () => {
  test("children follow their root's section regardless of their own value", () => {
    const a = proj("a", null, "open");
    const a1 = proj("a1", "a", "done"); // own value differs — follows root "a"
    const a2 = proj("a2", "a1", null); // nested descendant
    const b = proj("b", null, "done");
    const rows = [a, a1, a2, b];
    const buckets = bucketRowsByRootSection(
      rows,
      sectionsOf(["open", [a]], ["done", [b]]),
    );
    expect(buckets.map((bucket) => bucket.map((p) => p.id))).toEqual([
      ["a", "a1", "a2"],
      ["b"],
    ]);
  });

  test("buckets preserve the incoming projected order", () => {
    const a = proj("a", null, "open");
    const b = proj("b", null, "open");
    const b1 = proj("b1", "b");
    const a1 = proj("a1", "a");
    // Interleaved input (the sorted order) — the bucket keeps it verbatim.
    const rows = [a, b, b1, a1];
    const [bucket] = bucketRowsByRootSection(
      rows,
      sectionsOf(["open", [a, b]]),
    );
    expect(bucket!.map((p) => p.id)).toEqual(["a", "b", "b1", "a1"]);
  });

  test("an orphan (absent parent) is its own root", () => {
    const a = proj("a", null, "open");
    const c = proj("c", "missing", "done");
    const c1 = proj("c1", "c");
    const rows = [a, c, c1];
    const buckets = bucketRowsByRootSection(
      rows,
      sectionsOf(["open", [a]], ["done", [c]]),
    );
    expect(buckets.map((bucket) => bucket.map((p) => p.id))).toEqual([
      ["a"],
      ["c", "c1"],
    ]);
  });

  test("a root missing from every section fails loudly", () => {
    const a = proj("a", null, "open");
    const b = proj("b", null, "done");
    expect(() =>
      bucketRowsByRootSection([a, b], sectionsOf(["open", [a]])),
    ).toThrow(/root of row "b"/);
  });

  test("a parent cycle terminates instead of looping", () => {
    // Corrupt data: x ⇄ y. buildTree renders neither; bucketing just must not
    // hang. Both climb to a self-root and land in whatever section holds it —
    // here none, so the loud-miss throw is the observable end state.
    const x = proj("x", "y");
    const y = proj("y", "x");
    const a = proj("a", null, "open");
    expect(() =>
      bucketRowsByRootSection([a, x, y], sectionsOf(["open", [a]])),
    ).toThrow(/is in no section/);
  });
});
