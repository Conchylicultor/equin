import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  DataViewRowsComplete,
  FieldDef,
  TableCellProps,
} from "../../core";
import { DataViewSlots } from "../slots";
import { useResolveCell } from "../cell-slot";
import { useResolveCellEditor } from "../cell-editor-slot";
import { FieldCell } from "../components/field-cell";
import { FieldPresentationProvider } from "../internal/field-presentation";

/**
 * A row view's `FieldPresentationProvider`: chip-typed cells are handed
 * `presentation: "quiet"`, and the value most of the view's rows hold is left
 * out — only once the rows are complete, only when no row has the field empty,
 * and never outside a provider (the table).
 */

type Row = { id: string; kind: string; tags: string[]; note: string };

function ChipCell(props: TableCellProps): ReactNode {
  const shown = props.values ? props.values.join("+") : String(props.value);
  return <span>{`${props.presentation ?? "chip"}:${shown}`}</span>;
}

function PlainCell(props: TableCellProps): ReactNode {
  return <span>{`plain:${String(props.value)}`}</span>;
}

const plugin = {
  id: "data-view-field-presentation-test",
  description: "field presentation fixture",
  contributions: [
    DataViewSlots.Cell({ match: "chippy", component: ChipCell, chip: true }),
    DataViewSlots.Cell({ match: "taggy", component: ChipCell, chip: true }),
    DataViewSlots.Cell({ match: "planar", component: PlainCell }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

const KIND: FieldDef<Row> = {
  id: "kind",
  label: "Kind",
  type: "chippy",
  value: (r) => r.kind,
};
const TAGS: FieldDef<Row> = {
  id: "tags",
  label: "Tags",
  type: "taggy",
  values: (r) => r.tags,
};
const NOTE: FieldDef<Row> = {
  id: "note",
  label: "Note",
  type: "planar",
  value: (r) => r.note,
};

function rows(kinds: string[], tags?: string[][]): Row[] {
  return kinds.map((kind, i) => ({
    id: String(i),
    kind,
    tags: tags?.[i] ?? ["x"],
    note: "same",
  }));
}

function Cells({ field, all }: { field: FieldDef<Row>; all: Row[] }) {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return all.map((row) => (
    <div key={row.id} data-row={row.id}>
      <FieldCell
        field={field as FieldDef<unknown>}
        row={row}
        resolveCell={resolveCell}
        resolveEditor={resolveEditor}
      />
    </div>
  ));
}

/** Each row's drawn text for `field`, inside a provider (or not). */
function drawn(
  field: FieldDef<Row>,
  all: Row[],
  opts: { provider?: boolean; complete?: DataViewRowsComplete<unknown> } = {},
): string[] {
  const cells = <Cells field={field} all={all} />;
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      {opts.provider === false ? (
        cells
      ) : (
        <FieldPresentationProvider
          rows={all}
          fields={[KIND, TAGS, NOTE] as FieldDef<unknown>[]}
          rowsComplete={opts.complete ?? true}
        >
          {cells}
        </FieldPresentationProvider>
      )}
    </PluginProvider>,
  );
  const out = [...container.querySelectorAll("[data-row]")].map(
    (el) => el.textContent ?? "",
  );
  cleanup();
  return out;
}

afterEach(cleanup);

describe("FieldPresentationProvider: quiet", () => {
  it("hands a chip-typed cell `presentation: quiet`", () => {
    expect(drawn(KIND, rows(["a", "b", "c"]))).toEqual([
      "quiet:a",
      "quiet:b",
      "quiet:c",
    ]);
  });

  it("outside a provider (the table) the cell keeps its chip and nothing is elided", () => {
    expect(
      drawn(KIND, rows(["a", "a", "a", "b"]), { provider: false }),
    ).toEqual(["chip:a", "chip:a", "chip:a", "chip:b"]);
  });
});

describe("FieldPresentationProvider: common-value elision", () => {
  it("leaves out a value held by at least 60% of the rows", () => {
    expect(drawn(KIND, rows(["a", "a", "a", "b", "c"]))).toEqual([
      "",
      "",
      "",
      "quiet:b",
      "quiet:c",
    ]);
  });

  it("keeps a value held by fewer than 60%", () => {
    expect(drawn(KIND, rows(["a", "a", "b", "c", "d"]))).toEqual([
      "quiet:a",
      "quiet:a",
      "quiet:b",
      "quiet:c",
      "quiet:d",
    ]);
  });

  it("is blocked by a single row with the field empty", () => {
    expect(drawn(KIND, rows(["a", "a", "a", "a", ""]))).toEqual([
      "quiet:a",
      "quiet:a",
      "quiet:a",
      "quiet:a",
      // The empty row's own cell (the fixture draws whatever it is handed).
      "quiet:",
    ]);
  });

  it("waits for the rows to be complete (a paged read)", () => {
    const paged = { growable: () => true, total: null };
    expect(
      drawn(KIND, rows(["a", "a", "a", "b"]), { complete: paged }),
    ).toEqual(["quiet:a", "quiet:a", "quiet:a", "quiet:b"]);
  });

  it("filters the common member out of a multi-value field", () => {
    const all = rows(
      ["a", "b", "c", "d"],
      [["x", "y"], ["x"], ["x", "z"], ["w"]],
    );
    expect(drawn(TAGS, all)).toEqual(["quiet:y", "", "quiet:z", "quiet:w"]);
  });

  it("never elides a field that does not present as a chip", () => {
    expect(drawn(NOTE, rows(["a", "b", "c"]))).toEqual([
      "plain:same",
      "plain:same",
      "plain:same",
    ]);
  });
});
