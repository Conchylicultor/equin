import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "../components/list-view";

/** Stands in for the real enum cell: a chip, declaring itself one. */
function ChipCell(props: TableCellProps) {
  return <Badge variant="muted">{String(props.value ?? "")}</Badge>;
}

/** A contributed cell that is NOT a chip — it declares no `chip` flag, so the
 *  list must treat its term as text and keep the middot around it. */
function PlainCell(props: TableCellProps) {
  return <span>{String(props.value ?? "")}</span>;
}

const plugin = {
  id: "data-view-list-chip-separator-test",
  description: "list chip-separator fixture",
  contributions: [
    DataViewSlots.Cell({ match: "chippy", component: ChipCell, chip: true }),
    DataViewSlots.Cell({ match: "planar", component: PlainCell }),
  ],
  // A rendered slot must be a DECLARED slot — `renderIsolated` reads the slot id,
  // which is derived from the declaring plugin's id plus its `slots` key. In the
  // app that declaration is data-view's own barrel; here the fixture stands in
  // for it.
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; a: string; kind: string; b: string };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
  { id: "a", label: "A", type: "planar", value: (r) => r.a },
  { id: "kind", label: "Kind", type: "chippy", value: (r) => r.kind },
  { id: "b", label: "B", type: "text", value: (r) => r.b },
];

const ROW: Row = {
  id: "1",
  name: "alpha",
  a: "one",
  kind: "webpage",
  b: "two",
};

function renderList(options?: unknown) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    // Every non-title field is the subtitle run.
    placement: { place: { a: "line2", kind: "line2", b: "line2" } },
    rows: [ROW],
    fields: FIELDS,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Grouping inputs. These fixtures render UNGROUPED, so the clock is never
    // consulted — a pinned zero states that rather than borrowing the real one.
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

afterEach(cleanup);

describe("data-view list subtitle separators", () => {
  it("middots two adjacent text terms and never a chip", () => {
    const { container } = renderList({ lines: 1 });
    const text = container.textContent ?? "";

    // Two adjacent NON-chip terms — the title and `a` — keep the middot.
    expect(text).toContain("alpha · one");
    // The chip is separated by spacing alone, on BOTH sides.
    expect(text).toContain("one webpage two");
    expect(text).not.toContain("· webpage");
    expect(text).not.toContain("webpage ·");
  });

  it("applies the same rule in the stacked shape, minus the title seam", () => {
    const { container } = renderList({ lines: 2 });
    const text = container.textContent ?? "";

    // The subtitle starts its own line, so it starts its own run — no leading
    // separator, and the chip still parts its neighbours with spacing alone.
    expect(text).toContain("alphaone webpage two");
    expect(text).not.toContain("· webpage");
    expect(text).not.toContain("webpage ·");
  });
});
