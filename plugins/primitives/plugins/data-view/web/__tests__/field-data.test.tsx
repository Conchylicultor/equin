import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * `FieldDef.data` — the structured, display-only projection — end to end
 * through the one read pipeline: `FieldCell` → `resolveCell` →
 * `TableCellProps.data`. The cell is a local fixture for a synthetic type, so
 * the suite names no real field type (importing one would be a cycle).
 */

type Spec = { glyph: string; tint: string };
type Row = { id: string; spec: Spec };

function SpecCell(props: TableCellProps): ReactNode {
  const spec = props.data as Spec;
  return (
    <span data-testid="spec-cell" data-tint={spec.tint}>
      {spec.glyph}
    </span>
  );
}

const plugin = {
  id: "data-view-field-data-test",
  description: "field data fixture",
  contributions: [DataViewSlots.Cell({ match: "spec", component: SpecCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

function Harness({ field, row }: { field: FieldDef<Row>; row: Row }) {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <FieldCell
      field={field as FieldDef<unknown>}
      row={row}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
    />
  );
}

const ROW: Row = { id: "1", spec: { glyph: "★", tint: "amber" } };

afterEach(cleanup);

describe("FieldDef.data", () => {
  it("reaches the type's cell as TableCellProps.data", () => {
    const { getByTestId } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{
            id: "spec",
            label: "Spec",
            type: "spec",
            data: (r) => r.spec,
          }}
          row={ROW}
        />
      </PluginProvider>,
    );
    const cell = getByTestId("spec-cell");
    expect(cell.textContent).toBe("★");
    expect(cell.getAttribute("data-tint")).toBe("amber");
  });

  it("throws, naming the field and type, when no cell can draw the data", () => {
    // React logs the thrown render error before rethrowing; keep the output clean.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <PluginProvider plugins={[plugin]}>
            <Harness
              field={{
                id: "badge",
                label: "Badge",
                type: "unregistered",
                data: (r) => r.spec,
              }}
              row={ROW}
            />
          </PluginProvider>,
        ),
      ).toThrow(/"badge".*"unregistered"/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still defers to a consumer `cell` override", () => {
    const { getByText } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{
            id: "badge",
            label: "Badge",
            type: "unregistered",
            data: (r) => r.spec,
            cell: (r) => <span>{`override ${r.spec.glyph}`}</span>,
          }}
          row={ROW}
        />
      </PluginProvider>,
    );
    expect(getByText("override ★")).toBeTruthy();
  });

  it("keeps the String(value) fallback for a field with no data", () => {
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{
            id: "name",
            label: "Name",
            type: "unregistered",
            value: (r) => r.id,
          }}
          row={ROW}
        />
      </PluginProvider>,
    );
    expect(container.textContent).toBe("1");
  });
});

describe("FieldDef.readError", () => {
  it("renders the failure with Retry in place of the value", () => {
    const refetch = vi.fn(() => Promise.resolve());
    const { getByRole, queryByTestId } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{
            id: "spec",
            label: "Spec",
            type: "spec",
            data: (r) => r.spec,
            readError: { error: new Error("values unreachable"), refetch },
          }}
          row={ROW}
        />
      </PluginProvider>,
    );
    // No value is drawn — neither the type cell nor an unset fallback.
    expect(queryByTestId("spec-cell")).toBeNull();
    const button = getByRole("button", { name: /values unreachable/ });
    button.click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
