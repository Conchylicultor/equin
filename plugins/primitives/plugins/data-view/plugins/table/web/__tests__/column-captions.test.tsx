import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";
import type { TableViewOptions } from "../../core";
import tablePlugin from "../index";

/**
 * The table's column captions: the view instance's `columnCaptions` switch
 * (the view-type's `configSchema`), else the code's `header`, else the
 * presentation's default (`grid` / `soft` shown, `outline` not) — for the flat
 * and the nested table alike. And the labels' look: token-driven in every
 * presentation, an unsorted column's arrow revealed by the `sortIcon` token.
 */

const plugin = {
  id: "data-view-table-column-captions-test",
  description: "table column-captions fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = { id: string; parent: string | null; name: string; size: string };

const ROWS: Row[] = [
  { id: "src", parent: null, name: "src", size: "—" },
  { id: "readme", parent: null, name: "README.md", size: "2 KB" },
];

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    primary: true,
    value: (r) => r.name,
  },
  { id: "size", label: "Size", type: "plain", value: (r) => r.size },
];

function renderTable(options: TableViewOptions<Row>, nested = false) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: ROWS,
    fields: FIELDS,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: {
      active: [{ fieldId: "name", direction: "asc" }],
      sortable: new Set(["name", "size"]),
    },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    ...(nested
      ? {
          hierarchy: {
            getParentId: (r: Row) => r.parent,
            getRank: (r: Row) => Rank.from(r.id === "readme" ? "a1" : "a0"),
          },
        }
      : {}),
    options,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <TableView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const headerRow = () =>
  document.querySelector<HTMLElement>('[data-slot="data-table-header"]');

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

describe("data-view table: column captions", () => {
  it("declares the Column captions switch on the view type", () => {
    const view = tablePlugin.contributions[0] as unknown as {
      configSchema?: Record<string, { meta?: { label?: string } }>;
    };
    expect(view.configSchema?.columnCaptions?.meta?.label).toBe(
      "Column captions",
    );
  });

  it("flat: shown by default, hidden by the switch, which wins over header", () => {
    renderTable({});
    expect(headerRow()).not.toBeNull();
    cleanup();
    renderTable({ columnCaptions: "hidden" });
    expect(headerRow()).toBeNull();
    cleanup();
    renderTable({ header: true, columnCaptions: "hidden" });
    expect(headerRow()).toBeNull();
    cleanup();
    renderTable({ header: false });
    expect(headerRow()).toBeNull();
  });

  it("nested outline: hidden by default, shown by the switch", () => {
    renderTable({ presentation: "outline" }, true);
    expect(headerRow()).toBeNull();
    cleanup();
    renderTable({ presentation: "outline", columnCaptions: "shown" }, true);
    expect(headerRow()?.textContent).toContain("Size");
    cleanup();
    renderTable(
      { presentation: "outline", header: true, columnCaptions: "hidden" },
      true,
    );
    expect(headerRow()).toBeNull();
    cleanup();
    renderTable(
      { presentation: "outline", header: true, columnCaptions: "auto" },
      true,
    );
    expect(headerRow()).not.toBeNull();
  });

  it("grid labels take the columnHeader tokens and reveal unsorted arrows by sortIcon", () => {
    renderTable({});
    const h = headerRow()!;
    expect(h.style.getPropertyValue("--role-pick")).toBe(
      "var(--column-header-role)",
    );
    expect(h.className).not.toMatch(/\buppercase\b|tracking-wider/);
    const [name, size] = [...h.children] as HTMLElement[];
    expect(name!.className).toContain("text-column-header-sorted-ink");
    expect(size!.className).toContain("text-column-header-ink");
    expect(size!.className).toContain(
      "[@container_style(--column-header-case:upper)]:uppercase",
    );
    expect(size!.className).toContain("group/column-header");
    const unsorted = size!.querySelector("svg")!.getAttribute("class")!;
    expect(unsorted).toContain(
      "[@container_style(--sort-icon:hover)]:opacity-0",
    );
    expect(unsorted).toContain(
      "[@container_style(--sort-icon:hover)]:group-hover/column-header:opacity-100",
    );
    expect(unsorted).toContain("[@container_style(--sort-icon:sorted)]:hidden");
    const sorted = name!.querySelector("svg")!.getAttribute("class")!;
    expect(sorted).toContain("text-foreground");
    expect(sorted).not.toContain("--sort-icon");
  });
});
