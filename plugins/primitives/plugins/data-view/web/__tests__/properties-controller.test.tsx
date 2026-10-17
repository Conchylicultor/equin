/**
 * The Properties list keeps every field in its place: a toggle commits the
 * WHOLE list (hidden entries included), so hiding then showing a field returns
 * it where it was, and a field the stored list does not name arrives hidden at
 * the end of its band.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { FieldDef, PropertyEntry } from "../../core";
import { usePropertiesController } from "../internal/use-properties-controller";

afterEach(cleanup);

type Row = { id: string };
const field = (id: string, section?: string): FieldDef<Row> => ({
  id,
  label: id,
  ...(section ? { section } : {}),
});
const FIELDS = [field("a"), field("b"), field("c"), field("d")];

/** Drive the controller like the host does: every commit becomes the next
 *  stored list. */
function harness(fields: FieldDef<Row>[], initial: PropertyEntry[] | null) {
  let stored = initial;
  const { result, rerender } = renderHook(() =>
    usePropertiesController(fields, stored, (next) => {
      stored = next;
    }),
  );
  return {
    act(fn: (c: typeof result.current) => void) {
      fn(result.current);
      rerender();
    },
    get stored() {
      return stored;
    },
    get items() {
      return result.current.items.map(
        (i) => `${i.field.id}${i.visible ? "" : "~"}`,
      );
    },
  };
}

describe("usePropertiesController", () => {
  it("hiding then showing a field returns it to the same place", () => {
    const h = harness(FIELDS, null);
    h.act((c) => c.toggle("b"));
    expect(h.items).toEqual(["a", "b~", "c", "d"]);
    expect(h.stored).toEqual([
      { id: "a" },
      { id: "b", hidden: true },
      { id: "c" },
      { id: "d" },
    ]);
    h.act((c) => c.toggle("b"));
    expect(h.items).toEqual(["a", "b", "c", "d"]);
  });

  it("a move keeps the hidden entries where they are", () => {
    const h = harness(FIELDS, [
      { id: "a" },
      { id: "b", hidden: true },
      { id: "c" },
      { id: "d" },
    ]);
    h.act((c) => c.move("d", 0));
    expect(h.items).toEqual(["d", "a", "b~", "c"]);
  });

  it("a field the list does not name arrives hidden at the end of its band", () => {
    const fields = [
      field("a"),
      field("new"),
      field("b"),
      field("build.x", "Build"),
    ];
    const h = harness(fields, [{ id: "b" }, { id: "a" }, { id: "build.x" }]);
    expect(h.items).toEqual(["b", "a", "new~", "build.x"]);
  });

  it("drops stored ids the schema no longer has", () => {
    const h = harness(FIELDS, [{ id: "gone" }, { id: "c" }, { id: "a" }]);
    expect(h.items).toEqual(["c", "a", "b~", "d~"]);
  });

  it("unconfigured seeds from the schema default; showAll resets to it", () => {
    const fields = [field("a"), { ...field("b"), visible: false }];
    const h = harness(fields, [{ id: "a", hidden: true }]);
    h.act((c) => c.showAll());
    expect(h.stored).toBeNull();
    expect(h.items).toEqual(["a", "b~"]);
  });
});
