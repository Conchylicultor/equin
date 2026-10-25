import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { FieldDef, TableCellProps } from "../../core";
import { DataViewSlots } from "../slots";
import { useResolveCell } from "../cell-slot";
import { useResolveCellEditor } from "../cell-editor-slot";
import { FieldCell } from "../components/field-cell";
import { FieldExtentsContext } from "../internal/field-extents";

/**
 * `FieldCell context="token"` resolves `field.token` → `field.cell` → the
 * type's cell; the default `cell` context never reads `token`.
 */

type Row = { id: string; plays: number };

function CountCell(props: TableCellProps): ReactNode {
  return <span>type:{String(props.value)}</span>;
}

const plugin = {
  id: "data-view-field-cell-token-test",
  description: "field cell token fixture",
  contributions: [DataViewSlots.Cell({ match: "count", component: CountCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

function Harness({
  field,
  context,
}: {
  field: FieldDef<Row>;
  context?: "cell" | "token";
}) {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <FieldCell
      field={field as FieldDef<unknown>}
      row={{ id: "1", plays: 12 } satisfies Row}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
      context={context}
    />
  );
}

const base: FieldDef<Row> = {
  id: "plays",
  label: "Plays",
  type: "count",
  value: (r) => r.plays,
};

function text(
  field: FieldDef<Row>,
  context?: "cell" | "token",
  extents: ReadonlyMap<string, { min: number; max: number } | null> = new Map(),
): string {
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      <FieldExtentsContext.Provider value={extents}>
        <Harness field={field} context={context} />
      </FieldExtentsContext.Provider>
    </PluginProvider>,
  );
  const out = container.textContent ?? "";
  cleanup();
  return out;
}

afterEach(cleanup);

describe("FieldCell context", () => {
  it("token: field.token wins over field.cell and the type's cell", () => {
    const field: FieldDef<Row> = {
      ...base,
      cell: (r) => `cell:${r.plays}`,
      token: (r) => `${r.plays}×`,
    };
    expect(text(field, "token")).toBe("12×");
    expect(text(field, "cell")).toBe("cell:12");
    expect(text(field)).toBe("cell:12");
  });

  it("token: without field.token, field.cell, then the type's cell", () => {
    expect(text({ ...base, cell: (r) => `cell:${r.plays}` }, "token")).toBe(
      "cell:12",
    );
    expect(text(base, "token")).toBe("type:12");
  });
});

describe("FieldCell extent", () => {
  const draw = (
    _r: Row,
    ctx?: { extent: { min: number; max: number } | null },
  ) => (ctx?.extent ? `${ctx.extent.min}-${ctx.extent.max}` : "none");
  const extents = new Map([["plays", { min: 1, max: 40 }]]);

  it("an `extent: true` field's cell and token are handed the view's extent", () => {
    const field: FieldDef<Row> = {
      ...base,
      extent: true,
      cell: draw,
      token: draw,
    };
    expect(text(field, "cell", extents)).toBe("1-40");
    expect(text(field, "token", extents)).toBe("1-40");
  });

  it("a field without `extent: true` is handed none, whatever the view holds", () => {
    expect(text({ ...base, cell: draw }, "cell", extents)).toBe("none");
  });

  it("outside a view (no extent for it): null", () => {
    expect(text({ ...base, extent: true, cell: draw }, "cell")).toBe("none");
  });
});
