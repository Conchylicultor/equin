/**
 * A row read on its own (`FieldDef.rowState`, stamped by the client-values
 * fold from a reader's `rowPending` / `rowFailed`) is never drawn as a value:
 * its cell is the loading block or the failure — and not editable — and a
 * view laid out by the field lists it in the pending tail instead of placing
 * it (`NotKnownRowsTail`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { rowFailed, rowPending } from "@plugins/network/plugins/live/core";
import type { FieldDef } from "../../core";
import { DataViewSlots } from "../slots";
import { useResolveCell } from "../cell-slot";
import { useResolveCellEditor } from "../cell-editor-slot";
import { FieldCell } from "../components/field-cell";
import { NotKnownRowsTail } from "../components/not-known-rows-tail";
import { partitionKnownRows, splitRowReader } from "../internal/field-read";

type Row = { id: string };

const plugin = {
  id: "data-view-row-state-test",
  description: "row-state fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

const boom = new Error("probe failed");
const split = splitRowReader((row) => {
  const id = (row as Row).id;
  return id === "known"
    ? "v1.2"
    : id === "pending"
      ? rowPending
      : rowFailed(boom);
});
const field: FieldDef<Row> = {
  id: "release",
  label: "Release",
  value: split.value,
  rowState: split.rowState,
  onEdit: () => {},
};

function Cell({ row }: { row: Row }) {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <div data-testid={`cell-${row.id}`}>
      <FieldCell
        field={field as FieldDef<unknown>}
        row={row}
        resolveCell={resolveCell}
        resolveEditor={resolveEditor}
      />
    </div>
  );
}

afterEach(cleanup);

describe("per-row read state", () => {
  it("draws the value, the loading block or the failure per row — never a blank", () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <Cell row={{ id: "known" }} />
        <Cell row={{ id: "pending" }} />
        <Cell row={{ id: "failed" }} />
      </PluginProvider>,
    );
    expect(screen.getByTestId("cell-known").textContent).toContain("v1.2");
    expect(
      screen.getByTestId("cell-pending").querySelector('[aria-busy="true"]'),
    ).not.toBeNull();
    // Not editable while not known: no pencil.
    expect(
      screen.getByTestId("cell-pending").querySelector("button"),
    ).toBeNull();
    expect(screen.getByTestId("cell-failed").textContent).not.toContain("v1.2");
    expect(
      screen.getByTestId("cell-failed").querySelector('[aria-busy="true"]'),
    ).toBeNull();
  });

  it("a view laid out by the field lists the rows it cannot place in its tail", () => {
    const rows: Row[] = [{ id: "known" }, { id: "pending" }, { id: "failed" }];
    const { laidOut, notKnown } = partitionKnownRows(rows, [
      field as FieldDef<unknown>,
    ]);
    expect(laidOut).toEqual([{ id: "known" }]);
    render(<NotKnownRowsTail rows={notKnown} />);
    const tail = screen.getByTestId("not-known-rows-tail");
    expect(tail.textContent).toContain("Checking 1 row (Release)…");
    expect(tail.textContent).toContain("probe failed");
  });
});
