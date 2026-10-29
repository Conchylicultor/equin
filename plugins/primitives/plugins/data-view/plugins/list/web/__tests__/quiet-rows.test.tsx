import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "../components/list-view";

// The list's quiet rows: chip-typed terms drawn quiet, the value most rows
// share left out, the trailing fields in aligned slots (time-typed last), and
// the optional caption row.

function ChipCell(props: TableCellProps) {
  return (
    <span data-presentation={props.presentation ?? "chip"}>
      {String(props.value ?? "")}
    </span>
  );
}

const plugin = {
  id: "data-view-list-quiet-rows-test",
  description: "list quiet rows fixture",
  contributions: [
    DataViewSlots.Cell({ match: "chippy", component: ChipCell, chip: true }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = {
  id: string;
  name: string;
  kind: string;
  when: string;
  size: string;
};

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
  { id: "kind", label: "Kind", type: "chippy", value: (r) => r.kind },
  // Declared first, drawn last: a time-typed trailing field is the row's edge.
  {
    id: "when",
    label: "When",
    type: "date",
    value: (r) => r.when,
    align: "end",
  },
  {
    id: "size",
    label: "Size",
    type: "text",
    value: (r) => r.size,
    align: "end",
  },
];

const ROWS: Row[] = [
  { id: "1", name: "alpha", kind: "web", when: "5m", size: "1 KB" },
  { id: "2", name: "beta", kind: "web", when: "6m", size: "2 KB" },
  { id: "3", name: "gamma", kind: "web", when: "7m", size: "3 KB" },
  { id: "4", name: "delta", kind: "file", when: "8m", size: "4 KB" },
];

function renderList(options?: unknown) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    // The kind is a subtitle term; the time-typed field is the row's edge.
    placement: { place: { kind: "line2", when: "edge" } },
    rows: ROWS,
    fields: FIELDS,
    rowKey: (r) => r.id,
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
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const rowOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-row-key="${id}"]`)!;

afterEach(cleanup);

describe("data-view list: quiet rows", () => {
  it("draws chip-typed terms quiet", () => {
    const { container } = renderList();
    const cell = rowOf(container, "4").querySelector("[data-presentation]");
    expect(cell?.getAttribute("data-presentation")).toBe("quiet");
  });

  it("leaves out the value most rows share, separator and all", () => {
    const { container } = renderList();
    // "web" is three rows of four: it says nothing, so those rows drop it.
    expect(rowOf(container, "1").textContent).not.toContain("web");
    expect(rowOf(container, "1").textContent).toContain("alpha");
    // The exception still reads.
    expect(rowOf(container, "4").textContent).toContain("file");
  });

  it("puts the trailing fields in aligned slots, the time-typed one last", () => {
    const { container } = renderList();
    const slots = [
      ...rowOf(container, "1").querySelectorAll<HTMLElement>(
        "[data-list-slot]",
      ),
    ];
    expect(slots.map((s) => s.getAttribute("data-list-slot"))).toEqual([
      "size",
      "when",
    ]);
    // Each slot is as wide as its column: a CSS variable on the list root.
    expect(slots[0]!.style.minWidth).toBe("var(--list-slot-w-0)");
    expect(slots[1]!.className).toContain("text-list-time-ink");
    expect(slots[0]!.className).not.toContain("text-list-time-ink");
  });

  it("draws no caption row by default", () => {
    const { container } = renderList();
    expect(container.querySelector("[data-list-captions]")).toBeNull();
  });

  it("columnCaptions: the title label, and each trailing label over its slot", () => {
    const { container } = renderList({ columnCaptions: true });
    const captions = container.querySelector<HTMLElement>(
      "[data-list-captions]",
    )!;
    expect(captions.textContent).toContain("Name");
    const slots = [
      ...captions.querySelectorAll<HTMLElement>("[data-list-slot]"),
    ];
    expect(slots.map((s) => s.textContent)).toEqual(["Size", "When"]);
    expect(slots[1]!.style.minWidth).toBe("var(--list-slot-w-1)");
  });
});
