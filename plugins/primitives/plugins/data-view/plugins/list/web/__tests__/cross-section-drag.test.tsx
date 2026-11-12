import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  DataViewRenderProps,
  FieldDef,
  ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { GroupEditConfig } from "@plugins/primitives/plugins/data-view/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { ListView } from "../components/list-view";

// Manual order across sections, end to end through the list and the
// rank-reorder provider: a row dragged into another section is laid out there
// while the drag is in flight, a drop on a section's header or empty band is
// anchorless, the "+ New section" target appears only while a row drags, an
// `alwaysGroup` option draws an empty section, and editable headers rename
// and drag their whole section.
//
// jsdom has no layout, so every box is stacked in document order (see
// `stackedRect`), recomputed on each read — a row the preview moves is
// measured where it now is.

const plugin = {
  id: "data-view-list-cross-section-drag-test",
  description: "list cross-section drag fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; section: string; rank: Rank };

const SECTION_FIELD: FieldDef<Row> = {
  id: "section",
  label: "Section",
  type: "text",
  groupable: true,
  value: (r) => r.section,
  options: [
    { value: "A", label: "A" },
    { value: "B", label: "B" },
    { value: "C", label: "C", alwaysGroup: true },
  ],
};

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.id,
    primary: true,
  },
  SECTION_FIELD,
];

const ROWS: Row[] = [
  { id: "a1", section: "A", rank: Rank.from("a1") },
  { id: "a2", section: "A", rank: Rank.from("a2") },
  { id: "b1", section: "B", rank: Rank.from("a3") },
  { id: "b2", section: "B", rank: Rank.from("a4") },
];

const H = 30;

/** The boxes the stacked layout gives a height: rows, headers, drop bands
 *  and the new-section card. Any other element spans the boxes it holds. */
const BOX =
  'div[data-row-key], [data-group-drop], [data-part="dv.group-header"], [data-part="dv.new-group"]';

function stackedRect(el: Element): DOMRect {
  const boxes = [...document.querySelectorAll(BOX)];
  // The outermost boxes, in document order, each one row tall.
  const outer = boxes.filter(
    (b) => !boxes.some((o) => o !== b && o.contains(b)),
  );
  const top = new Map(outer.map((b, i) => [b, i * H]));
  const own = outer.find((b) => b === el || b.contains(el));
  let span: [number, number] | null = null;
  if (own) {
    span = [top.get(own)!, top.get(own)! + H];
  } else {
    for (const b of outer) {
      if (!el.contains(b)) continue;
      const t = top.get(b)!;
      span = span
        ? [Math.min(span[0], t), Math.max(span[1], t + H)]
        : [t, t + H];
    }
  }
  const [y, bottom] = span ?? [0, 0];
  const width = span ? 200 : 0;
  return {
    x: 0,
    y,
    top: y,
    left: 0,
    width,
    height: bottom - y,
    right: width,
    bottom,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return stackedRect(this);
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

/** Press at `from`, pass the 4px activation, then move to each of `path`. */
function drag(el: Element, from: number, path: number[]): void {
  act(() => {
    fireEvent.pointerDown(el, pointer(10, from));
  });
  act(() => {
    fireEvent.pointerMove(document, pointer(10, from + 6));
  });
  for (const y of path) {
    act(() => {
      fireEvent.pointerMove(document, pointer(10, y));
    });
  }
}

function drop(y: number): void {
  act(() => {
    fireEvent.pointerUp(document, pointer(10, y));
  });
}

function props(
  extra: Partial<DataViewRenderProps<Row>>,
): DataViewRenderProps<unknown> {
  return {
    revealSelection: true,
    placement: {},
    rows: ROWS,
    fields: FIELDS,
    rowKey: (r: Row) => r.id,
    state: {
      sort: [],
      query: "",
      filter: null,
      groupBy: { fieldId: "section", groupingId: "value" },
    },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options: undefined,
    ...extra,
  } as DataViewRenderProps<Row> as DataViewRenderProps<unknown>;
}

function mount(node: ReactNode) {
  return render(<PluginProvider plugins={[plugin]}>{node}</PluginProvider>);
}

/** The row keys in the order they are drawn. */
function drawnKeys(container: HTMLElement): string[] {
  return [...container.querySelectorAll("div[data-row-key]")]
    .map((el) => el.getAttribute("data-row-key")!)
    .filter((key, i, all) => all.indexOf(key) === i);
}

const sourceOf = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`div[data-row-key="${key}"]`)!;

function manualOrder(
  extra: Partial<ManualOrderConfig<Row>> = {},
): ManualOrderConfig<Row> {
  return {
    getRank: (r) => r.rank,
    onMove: vi.fn(),
    onReseat: vi.fn(),
    ...extra,
  };
}

// The stacked layout, before any drag:
//   header A 0 · a1 30 · a2 60 · header B 90 · b1 120 · b2 150 ·
//   header C 180 · C's empty band 210
describe("data-view list cross-section drag", () => {
  it("lays a row out in the section it is dragged into, and drops it beside its new neighbour", () => {
    const order = manualOrder();
    const { container } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    expect(drawnKeys(container)).toEqual(["a1", "a2", "b1", "b2"]);

    // a1's box centre crosses b1's (135) — after it.
    drag(sourceOf(container, "a1"), 45, [140]);
    expect(drawnKeys(container)).toEqual(["a2", "b1", "a1", "b2"]);
    // And the section counts follow the row.
    const counts = [
      ...container.querySelectorAll('[data-part="dv.group-count"]'),
    ].map((el) => el.textContent);
    expect(counts).toEqual(["1", "3", "0"]);

    drop(140);
    expect(order.onMove).not.toHaveBeenCalled();
    expect(order.onReseat).toHaveBeenCalledTimes(1);
    expect(order.onReseat).toHaveBeenCalledWith("a1", {
      groupKey: "B",
      targetId: "b1",
      zone: "after",
    });
    // The drag is over: the preview is gone.
    expect(drawnKeys(container)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("draws an `alwaysGroup` section with no rows, and a drop on its band is anchorless", () => {
    const order = manualOrder();
    const { container, getByText } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    expect(getByText("C")).toBeTruthy();
    expect(getByText("Empty")).toBeTruthy();

    drag(sourceOf(container, "a1"), 45, [215]);
    drop(215);
    expect(order.onReseat).toHaveBeenCalledWith("a1", { groupKey: "C" });
  });

  it("takes a drop on another section's header into that section, anchorless", () => {
    const order = manualOrder();
    const { container } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    // Header C sits at 180–210.
    drag(sourceOf(container, "b2"), 165, [195]);
    drop(195);
    expect(order.onReseat).toHaveBeenCalledWith("b2", { groupKey: "C" });
  });

  it("still refuses another section without onReseat", () => {
    const order = manualOrder({ onReseat: undefined });
    const { container } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    drag(sourceOf(container, "a1"), 45, [140]);
    // Nothing moves into B: the drag only sees its own section.
    expect(drawnKeys(container)).toEqual(["a1", "a2", "b1", "b2"]);
    drop(140);
    expect(order.onMove).toHaveBeenCalledWith("a1", {
      rank: expect.anything(),
      targetId: "a2",
      zone: "after",
    });
  });

  it("leaves a section `reseatInto` refuses out of the drag: no slide, no header drop", () => {
    const order = manualOrder({ reseatInto: (key) => key !== "B" });
    const { container } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    // Over b1 (B refuses): the row is not laid out there.
    drag(sourceOf(container, "a1"), 45, [140]);
    expect(drawnKeys(container)).toEqual(["a1", "a2", "b1", "b2"]);
    // Over B's header: no anchorless drop into B either.
    act(() => {
      fireEvent.pointerMove(document, pointer(10, 105));
    });
    drop(105);
    expect(order.onReseat).not.toHaveBeenCalled();
    // C still takes it.
    drag(sourceOf(container, "a1"), 45, [215]);
    drop(215);
    expect(order.onReseat).toHaveBeenCalledWith("a1", { groupKey: "C" });
  });

  it("floats the new-section target only while a row drags, and reports a drop on it", () => {
    const onDrop = vi.fn();
    const order = manualOrder({
      onReseatNew: { label: "New section", onDrop },
    });
    const { container, queryByText } = mount(
      <ListView {...props({ manualOrder: order })} />,
    );
    expect(queryByText("New section")).toBeNull();

    // The card is the last box (240–270).
    drag(sourceOf(container, "a2"), 75, [80]);
    expect(queryByText("New section")).not.toBeNull();
    act(() => {
      fireEvent.pointerMove(document, pointer(10, 255));
    });
    expect(
      container
        .querySelector('[data-part="dv.new-group"]')!
        .hasAttribute("data-over"),
    ).toBe(true);
    drop(255);
    expect(onDrop).toHaveBeenCalledWith("a2");
    expect(order.onReseat).not.toHaveBeenCalled();
    expect(queryByText("New section")).toBeNull();
  });

  it("holds a dropped row in its new section while the write is in flight", () => {
    const { container } = mount(
      <ListView
        {...props({
          manualOrder: manualOrder(),
          heldReseats: [
            {
              id: "a1",
              dest: { groupKey: "B", targetId: "b2", zone: "after" },
            },
          ],
        })}
      />,
    );
    expect(drawnKeys(container)).toEqual(["a2", "b1", "b2", "a1"]);
  });
});

/** A host holding the rename state the way a consumer does. */
function EditableList(props_: {
  onRename: GroupEditConfig["onRename"];
  onMove: GroupEditConfig["onMove"];
}): ReactNode {
  const [renaming, setRenaming] = useState<string | null>(null);
  const groupEdit: GroupEditConfig = {
    editable: (key) => key !== "A",
    onRename: props_.onRename,
    onMove: props_.onMove,
    renaming,
    setRenaming,
  };
  return <ListView {...props({ manualOrder: manualOrder(), groupEdit })} />;
}

describe("data-view list editable section headers", () => {
  it("renames an editable header inline: double-click, type, Enter", () => {
    const onRename = vi.fn();
    const { getByText, getByLabelText, queryByLabelText } = mount(
      <EditableList onRename={onRename} onMove={vi.fn()} />,
    );
    // A fixed section's label opens nothing.
    fireEvent.doubleClick(getByText("A"));
    expect(queryByLabelText("Section name")).toBeNull();

    fireEvent.doubleClick(getByText("C"));
    const input = getByLabelText("Section name") as HTMLInputElement;
    expect(input.value).toBe("C");
    fireEvent.change(input, { target: { value: "  Later  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("C", "Later");
    expect(queryByLabelText("Section name")).toBeNull();
  });

  it("cancels a rename on Escape", () => {
    const onRename = vi.fn();
    const { getByText, getByLabelText, queryByLabelText } = mount(
      <EditableList onRename={onRename} onMove={vi.fn()} />,
    );
    fireEvent.doubleClick(getByText("B"));
    fireEvent.keyDown(getByLabelText("Section name"), { key: "Escape" });
    expect(queryByLabelText("Section name")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("drags an editable section by its header past the next one", () => {
    const onMove = vi.fn();
    const { getByText } = mount(
      <EditableList onRename={vi.fn()} onMove={onMove} />,
    );
    // Block B spans 90–180 (header + rows), block C 180–240.
    drag(getByText("B"), 105, [200]);
    drop(200);
    expect(onMove).toHaveBeenCalledWith("B", { targetKey: "C", zone: "after" });
  });

  it("still slides rows under editable headers: the dragged row follows the pointer", () => {
    // Regression: the group blocks once sat in a second, nested sortable
    // context, so every row found itself in no list — no row moved mid-drag.
    const { container } = mount(
      <EditableList onRename={vi.fn()} onMove={vi.fn()} />,
    );
    drag(sourceOf(container, "a1"), 45, [70]);
    expect(sourceOf(container, "a1").style.transform).toMatch(/translate/);
    drop(70);
  });
});
