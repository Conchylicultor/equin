import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  DataViewRenderProps,
  FieldDef,
  ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { ListView } from "../components/list-view";

// Each list row is a memo boundary: re-rendering the list re-renders only the
// rows whose own data or per-row state changed. Counted through
// `options.renderRow`, which runs exactly once per row render.

const plugin = {
  id: "data-view-list-row-memo-test",
  description: "list row memo fixture",
  contributions: [],
} as unknown as LoadedPlugin;
const PLUGINS = [plugin];

type Row = { id: string; name: string; rank: Rank | null };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
];

const row = (id: string, name = id, rank: string | null = null): Row => ({
  id,
  name,
  rank: rank === null ? null : Rank.from(rank),
});

const rowKey = (r: Row): string => r.id;

function setup(opts: { manualOrder?: ManualOrderConfig<Row> } = {}) {
  const renderRowSpy = vi.fn((r: Row): ReactNode => <span>{r.name}</span>);
  // The view's options as a host hands them: one stable object.
  const options = { renderRow: renderRowSpy };
  // Every call builds a FRESH props object, with fresh host closures
  // (`setExpanded`, `setSort`, …) and a fresh `state` — exactly what the
  // DataView host does on each of its renders.
  const propsFor = (
    rows: Row[],
    selectedRowId?: string,
  ): DataViewRenderProps<unknown> =>
    ({
      revealSelection: true,
      rows,
      fields: FIELDS,
      rowKey,
      state: { sort: [], query: "", filter: null },
      setSort: () => {},
      sortHeader: { active: [], sortable: new Set<string>() },
      setFilter: () => {},
      setExpanded: () => {},
      now: 0,
      groupOrder: "asc",
      rowsComplete: true,
      sectioning: { kind: "bucket" },
      options,
      selectedRowId,
      manualOrder: opts.manualOrder,
    }) as DataViewRenderProps<Row> as DataViewRenderProps<unknown>;
  const view = (rows: Row[], selectedRowId?: string) => (
    <PluginProvider plugins={PLUGINS}>
      <ListView {...propsFor(rows, selectedRowId)} />
    </PluginProvider>
  );
  return { renderRowSpy, view };
}

/** The ids `renderRow` drew, in call order, since the last reset. */
function drawn(spy: ReturnType<typeof setup>["renderRowSpy"]): string[] {
  return spy.mock.calls.map(([r]) => r.id);
}

afterEach(cleanup);

describe("data-view list rows are memo boundaries", () => {
  it("a re-render with the same row objects draws no row again", () => {
    const { renderRowSpy, view } = setup();
    const rows = [row("a"), row("b"), row("c")];
    const { rerender } = render(view(rows));
    expect(drawn(renderRowSpy)).toEqual(["a", "b", "c"]);

    renderRowSpy.mockClear();
    // A new array holding the same row objects, and a fresh props object.
    rerender(view([...rows]));
    expect(drawn(renderRowSpy)).toEqual([]);
  });

  it("one changed row re-renders only that row", () => {
    const { renderRowSpy, view } = setup();
    const rows = [row("a"), row("b"), row("c")];
    const { rerender, getByText } = render(view(rows));

    renderRowSpy.mockClear();
    rerender(view([rows[0]!, row("b", "renamed"), rows[2]!]));
    expect(drawn(renderRowSpy)).toEqual(["b"]);
    expect(getByText("renamed")).toBeTruthy();
  });

  it("a selection change re-renders only the rows it moves between", () => {
    const { renderRowSpy, view } = setup();
    const rows = [row("a"), row("b"), row("c")];
    const { rerender } = render(view(rows, "a"));

    renderRowSpy.mockClear();
    rerender(view(rows, "c"));
    expect(drawn(renderRowSpy).sort()).toEqual(["a", "c"]);
  });

  it("sortable rows registering with the drag context after mount do not redraw their content", () => {
    const { renderRowSpy, view } = setup({
      manualOrder: { getRank: (r) => r.rank, onMove: () => {} },
    });
    const rows = [
      row("a", "a", "a0"),
      row("b", "b", "a1"),
      row("c", "c", "a2"),
    ];
    // `render` flushes the mount effects, where every sortable row registers
    // its droppable and dnd-kit re-renders each `useSortable` consumer.
    render(view(rows));
    expect(drawn(renderRowSpy)).toEqual(["a", "b", "c"]);

    renderRowSpy.mockClear();
    act(() => {});
    expect(drawn(renderRowSpy)).toEqual([]);
  });
});
