import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  DataViewRenderProps,
  FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "../components/list-view";

// No contributions are needed: every field here is plain text with no `onEdit`,
// so `FieldCell` renders `String(value)` and never reaches a contributed cell or
// editor. The provider exists only because the view's resolve hooks read slots.
const plugin = {
  id: "data-view-list-row-lines-test",
  description: "list row-shape fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; status: string; when: string };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
  { id: "status", label: "Status", type: "text", value: (r) => r.status },
  {
    id: "when",
    label: "When",
    type: "text",
    value: (r) => r.when,
    align: "end",
  },
];

const ROW: Row = { id: "1", name: "alpha", status: "todo", when: "5m" };

function renderList(options?: unknown, row: Row = ROW) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: [row],
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

describe("data-view list row shape", () => {
  it("puts title, subtitle and trailing on ONE line by default", () => {
    const { getByText } = renderList();

    // `getByText` matches on an element's DIRECT text children, so this is the
    // title's own `<Text>` leaf, not an ancestor that merely contains it.
    const title = getByText("alpha");
    const trailing = getByText("5m");
    const line = title.parentElement;

    // The structural claim of `lines: 1`: the trailing cell is a sibling leaf in
    // the SAME line box as the title, not a sibling of a stacked column.
    expect(line?.contains(trailing)).toBe(true);
    // The `·` join extends to the seam with the title — on one line the title is
    // simply the run's first term.
    expect(line?.textContent).toContain("alpha · todo");
  });

  it("stacks the subtitle under the title at lines: 2", () => {
    const { getByText } = renderList({ lines: 2 });

    const title = getByText("alpha");
    const subtitle = getByText("todo");
    const trailing = getByText("5m");

    // The stacked column holds both the title and the subtitle…
    const column = title.parentElement;
    expect(column?.contains(subtitle)).toBe(true);
    // …and the trailing cell sits OUTSIDE it, pushed right of the whole two-line
    // block, exactly as this shape has always rendered.
    expect(column?.contains(trailing)).toBe(false);
    // No leading separator: the subtitle starts its own line, so it starts its
    // own run.
    expect(subtitle.textContent).toBe("todo");
  });

  it("leaves an empty subtitle value out of the run, in both shapes", () => {
    for (const options of [undefined, { lines: 2 }]) {
      const { container, queryByText } = renderList(options, {
        ...ROW,
        status: "",
      });
      // No italic placeholder and no dangling separator after the title.
      expect(queryByText("Empty")).toBeNull();
      expect(container.textContent).toBe("alpha5m");
      cleanup();
    }
  });
});
