import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

// A manual-order drag still lands, end to end through the list's memoized rows
// and the rank-reorder provider: press a row, move past the activation
// distance, drop it over the last row → `onMove` reports it after that row.
// jsdom has no layout, so each row's box comes from its position in the list.

const plugin = {
  id: "data-view-list-manual-order-drag-test",
  description: "list manual-order drag fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; rank: Rank };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
];

const ROWS: Row[] = ["a", "b", "c"].map((id, i) => ({
  id,
  name: id,
  rank: Rank.from(`a${i}`),
}));

const ROW_H = 30;

beforeEach(() => {
  // A vertical list: each `[data-row-key]` box stacked at its row's index.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const key = this.getAttribute("data-row-key");
      const i = key === null ? -1 : ROWS.findIndex((r) => r.id === key);
      const top = i < 0 ? 0 : i * ROW_H;
      const height = i < 0 ? 0 : ROW_H;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        width: i < 0 ? 0 : 200,
        height,
        right: i < 0 ? 0 : 200,
        bottom: top + height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pointer(x: number, y: number): PointerEventInit {
  return { clientX: x, clientY: y, isPrimary: true, button: 0, pointerId: 1 };
}

describe("data-view list manual-order drag", () => {
  it("drops a dragged row after the row it is released over", () => {
    const onMove = vi.fn();
    const manualOrder: ManualOrderConfig<Row> = {
      getRank: (r) => r.rank,
      onMove,
    };
    const props = {
      revealSelection: true,
      rows: ROWS,
      fields: FIELDS,
      rowKey: (r: Row) => r.id,
      state: { sort: [], query: "", filter: null },
      setSort: () => {},
      sortHeader: { active: [], sortable: new Set<string>() },
      setFilter: () => {},
      setExpanded: () => {},
      now: 0,
      groupOrder: "asc",
      rowsComplete: true,
      sectioning: { kind: "bucket" },
      options: undefined,
      manualOrder,
    } as DataViewRenderProps<Row> as DataViewRenderProps<unknown>;
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <ListView {...props} />
      </PluginProvider>,
    );
    // The sortable wrapper (the drag source) is the outer `[data-row-key]`.
    const source = container.querySelector<HTMLElement>(
      'div[data-row-key="a"]',
    )!;

    act(() => {
      fireEvent.pointerDown(source, pointer(10, 15));
    });
    act(() => {
      fireEvent.pointerMove(document, pointer(10, 25));
    });
    act(() => {
      fireEvent.pointerMove(document, pointer(10, 85));
    });
    act(() => {
      fireEvent.pointerUp(document, pointer(10, 85));
    });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, dest] = onMove.mock.calls[0]!;
    expect(id).toBe("a");
    expect(dest).toMatchObject({ targetId: "c", zone: "after" });
  });
});
