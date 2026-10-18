import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { act, type ReactNode } from "react";
import {
  markDeferredLoadComplete,
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import type { FieldDef, TableCellProps } from "../../core";
import { DataViewSlots } from "../slots";
import { useResolveCell } from "../cell-slot";
import { useResolveCellEditor } from "../cell-editor-slot";
import { FieldCell } from "../components/field-cell";

/**
 * A keyed companion the repo provides but the bundle lacks is loud, not a text
 * cell. The fixture declares DataView's slots under the primitive's REAL id, so
 * the slot ids match the committed companion manifest — whose `date` cell is
 * `fields.date.table`, deliberately not registered here.
 */

function MarkCell(props: TableCellProps): ReactNode {
  return <span data-testid="mark-cell">{String(props.value)}</span>;
}

const plugin = {
  id: "primitives.data-view",
  description: "data-view slots, a local cell only",
  contributions: [DataViewSlots.Cell({ match: "mark", component: MarkCell })],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; when: string };
const ROW: Row = { id: "1", when: "2026-10-18" };

function Harness({ field }: { field: FieldDef<Row> }) {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <FieldCell
      field={field as FieldDef<unknown>}
      row={ROW}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
    />
  );
}

const dateField: FieldDef<Row> = {
  id: "when",
  label: "When",
  type: "date",
  value: (r) => r.when,
};

afterEach(() => {
  cleanup();
  resetDeferredLoadStateForTests();
});

describe("a missing keyed companion", () => {
  it("throws once every plugin has loaded, naming the provider", () => {
    act(() => markDeferredLoadComplete());
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <PluginProvider plugins={[plugin]}>
            <Harness field={dateField} />
          </PluginProvider>,
        ),
      ).toThrow(/"date" is served by fields\.date\.table/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("is not judged while plugins are still loading", () => {
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness field={dateField} />
      </PluginProvider>,
    );
    expect(container.textContent).toBe("2026-10-18");
  });

  it("leaves a type nothing provides to its fallback", () => {
    act(() => markDeferredLoadComplete());
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{
            id: "x",
            label: "X",
            type: "unprovided",
            value: (r) => r.id,
          }}
        />
      </PluginProvider>,
    );
    expect(container.textContent).toBe("1");
  });

  it("finds a registered companion as before", () => {
    act(() => markDeferredLoadComplete());
    const { getByTestId } = render(
      <PluginProvider plugins={[plugin]}>
        <Harness
          field={{ id: "m", label: "M", type: "mark", value: (r) => r.id }}
        />
      </PluginProvider>,
    );
    expect(getByTestId("mark-cell").textContent).toBe("1");
  });
});
