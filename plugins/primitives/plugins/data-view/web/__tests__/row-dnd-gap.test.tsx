import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import type { ViewRowDropConfig } from "../../core";
import { useRowDnd, type RowDndSequence } from "../internal/row-dnd";

/**
 * Under `placement: "between"` a gap has ONE spelling — `"after"` the row
 * painted above it — so the pointer crossing from the upper row into the
 * lower one moves neither the target nor the insertion line, and the
 * section's trailing empty space is its last row's gap.
 */

type Row = { id: string };
const ROWS: Row[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
const TYPES = ["text/x-host-paths"];

const sequence: RowDndSequence<Row> = {
  above: (key) => {
    const i = ROWS.findIndex((r) => r.id === key);
    return i > 0 ? ROWS[i - 1]!.id : null;
  },
  rowOf: (key) => ROWS.find((r) => r.id === key),
};

/** A drag event over a 20px-tall row box, the pointer `y` px into it. */
function dragAt(y: number): DragEvent<HTMLElement> {
  const box = document.createElement("div");
  box.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  return {
    currentTarget: box,
    clientY: y,
    dataTransfer: { types: TYPES, dropEffect: "none" },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as DragEvent<HTMLElement>;
}

function mount(onDrop = vi.fn()) {
  const rowDrop: ViewRowDropConfig<Row> = {
    placement: "between",
    accepts: (_r, _t, edge) => edge !== "into",
    onDrop,
    background: { accepts: () => true, onDrop: vi.fn() },
  };
  const { result } = renderHook(() =>
    useRowDnd<Row>({
      rowDrag: undefined,
      rowDrop,
      dragRows: () => [],
      sequence,
    }),
  );
  return { dnd: result.current!, rowDrop };
}

describe("useRowDnd — between: one spelling per gap", () => {
  it("the lower half of a and the upper half of b are the same gap", () => {
    const { dnd } = mount();
    dnd.rowProps("a", ROWS[0]!).onDragOver!(dragAt(15));
    const fromAbove = dnd.store.get();
    dnd.rowProps("b", ROWS[1]!).onDragOver!(dragAt(5));
    expect(dnd.store.get()).toEqual(fromAbove);
    expect(fromAbove).toEqual({ kind: "row", key: "a", edge: "after" });
  });

  it("the first row's upper half is the only `before`", () => {
    const { dnd } = mount();
    dnd.rowProps("a", ROWS[0]!).onDragOver!(dragAt(5));
    expect(dnd.store.get()).toEqual({ kind: "row", key: "a", edge: "before" });
  });

  it("the section's trailing space is its last row's gap", () => {
    const { dnd } = mount();
    dnd.rowProps("c", ROWS[2]!).onDragOver!(dragAt(15));
    const fromRow = dnd.store.get();
    dnd.backgroundProps(null, "c")!.onDragOver(dragAt(30));
    expect(dnd.store.get()).toEqual(fromRow);
  });

  it("a drop in the upper half of b lands after a", () => {
    const onDrop = vi.fn();
    const { dnd, rowDrop } = mount(onDrop);
    dnd.rowProps("b", ROWS[1]!).onDrop!(dragAt(5));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![0]).toBe(ROWS[0]);
    expect(onDrop.mock.calls[0]![2]).toBe("after");
    expect(rowDrop.background!.onDrop).not.toHaveBeenCalled();
  });
});
