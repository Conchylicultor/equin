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

// Every field here is plain text with no `onEdit`, so `FieldCell` renders
// `String(value)` and never reaches a contributed cell or editor. The provider
// exists only because the view's resolve hooks read slots.
const plugin = {
  id: "data-view-list-row-tone-test",
  description: "list row-tone fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; enabled: boolean };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
];

const ROWS: Row[] = [
  { id: "1", name: "live", enabled: true },
  { id: "2", name: "switched-off", enabled: false },
];

function renderList(rowTone?: (row: Row) => "default" | "muted") {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: ROWS,
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
    options: undefined,
    rowTone,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("data-view list rowTone", () => {
  it("dims the title of a muted row and leaves a default row alone", () => {
    const { getByText } = renderList((r) => (r.enabled ? "default" : "muted"));

    // `getByText` matches on an element's DIRECT text children, so each of these
    // is the row's own title `<Text>` leaf.
    expect(getByText("switched-off").className).toContain(
      "text-muted-foreground",
    );
    // The default row keeps the title's own foreground and gains nothing.
    expect(getByText("live").className).toContain("text-foreground");
    expect(getByText("live").className).not.toContain("text-muted-foreground");
  });

  it("leaves every title at full emphasis when no accessor is supplied", () => {
    const { getByText } = renderList();

    for (const name of ["live", "switched-off"]) {
      expect(getByText(name).className).toContain("text-foreground");
      expect(getByText(name).className).not.toContain("text-muted-foreground");
    }
  });
});
