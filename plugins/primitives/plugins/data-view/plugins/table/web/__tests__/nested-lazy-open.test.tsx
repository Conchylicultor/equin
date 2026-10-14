import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  DataViewSlots,
  type DataViewRenderProps,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { TreeChildrenState } from "@plugins/primitives/plugins/tree/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { TableView } from "../components/table-view";

/**
 * What a file browser needs, through the nested table (the tree view's
 * `lazy-open-aligned.test.tsx`, ported): lazily-listed children (chevron
 * before any child, a load request for every open unlisted node, loading /
 * failed / empty placeholder lines), the open gesture (double-click / Enter,
 * distinct from the click), link rows, and the column header sorting the
 * sibling groups.
 */

const plugin = {
  id: "data-view-table-nested-lazy-open-test",
  description: "nested table lazy/open fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = {
  id: string;
  parent: string | null;
  name: string;
  isDir: boolean;
  modified: string;
  size: string;
};

const DIR: Row = {
  id: "src",
  parent: null,
  name: "src",
  isDir: true,
  modified: "Today",
  size: "3 items",
};
const FILE: Row = {
  id: "readme",
  parent: null,
  name: "README.md",
  isDir: false,
  modified: "Yesterday",
  size: "2 KB",
};

const nameField: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "plain",
  primary: true,
  value: (r) => r.name,
};
const modifiedField: FieldDef<Row> = {
  id: "modified",
  label: "Modified",
  type: "plain",
  width: "96px",
  value: (r) => r.modified,
};
const sizeField: FieldDef<Row> = {
  id: "size",
  label: "Size",
  type: "plain",
  width: "80px",
  value: (r) => r.size,
};

function renderTable(
  over: Partial<DataViewRenderProps<Row>> & {
    lazy?: HierarchyConfig<Row>["lazyChildren"];
  } = {},
) {
  const { lazy, ...rest } = over;
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: [DIR, FILE],
    fields: [nameField, modifiedField, sizeField],
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
    hierarchy: {
      getParentId: (r) => r.parent,
      getRank: (r) => Rank.from(r.id === "src" ? "a0" : "a1"),
      lazyChildren: lazy,
    },
    options: undefined,
    ...rest,
  };
  const ui = (p: DataViewRenderProps<Row>) => (
    <PluginProvider plugins={[plugin]}>
      <TableView {...(p as DataViewRenderProps<unknown>)} />
    </PluginProvider>
  );
  const result = render(ui(props));
  return {
    ...result,
    rerenderWith: (next: Partial<DataViewRenderProps<Row>>) =>
      result.rerender(ui({ ...props, ...next })),
  };
}

/** The focusable row element that carries a label. */
const rowOf = (label: HTMLElement) =>
  label.closest<HTMLElement>("[tabindex='0']")!;

afterEach(cleanup);

describe("data-view nested table: lazy children", () => {
  const lazyWith = (state: TreeChildrenState, load = vi.fn()) => ({
    hasChildren: (r: Row) => r.isDir,
    state: () => state,
    load,
  });

  it("gives an unlisted folder a live chevron, and not a file", () => {
    const setExpanded = vi.fn();
    const { getByText } = renderTable({
      lazy: lazyWith({ kind: "unloaded" }),
      setExpanded,
    });
    const chevronOf = (label: string) =>
      getByText(label)
        .closest("[data-tree-row]")!
        .querySelector<HTMLElement>("button[aria-label='Expand']");
    expect(chevronOf("src")!.className).not.toContain("pointer-events-none");
    expect(chevronOf("README.md")).toBeNull();
    fireEvent.click(chevronOf("src")!);
    expect(setExpanded).toHaveBeenCalledWith([{ id: "src", expanded: true }]);
  });

  it("asks an open, unlisted folder for its children once, and shows it loading", () => {
    const load = vi.fn();
    // An expand map restored on reload: no gesture happened, the folder is open.
    const { container, rerenderWith } = renderTable({
      lazy: lazyWith({ kind: "unloaded" }, load),
      expanded: { src: true },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toBe(DIR);
    expect(
      container.querySelector("[data-tree-placeholder='loading']")?.textContent,
    ).toContain("Loading");
    // A re-render with nothing changed asks no second time.
    rerenderWith({ expanded: { src: true } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a closed folder", () => {
    const load = vi.fn();
    renderTable({ lazy: lazyWith({ kind: "unloaded" }, load) });
    expect(load).not.toHaveBeenCalled();
  });

  it("renders a failed listing with its message and a Retry, across the row", () => {
    const retry = vi.fn();
    const { getByRole } = renderTable({
      lazy: lazyWith({ kind: "failed", message: "Permission denied", retry }),
      expanded: { src: true },
    });
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("Permission denied");
    // A placeholder is one full-span line, not a row of cells.
    expect(alert.closest("[data-tree-row]")).toBeNull();
    expect(alert.parentElement!.className).toContain("col-span-full");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("says a listed folder with no children is empty", () => {
    const { getByText } = renderTable({
      lazy: lazyWith({ kind: "loaded" }),
      expanded: { src: true },
    });
    expect(getByText("Empty")).toBeTruthy();
  });

  it("renders loaded children with no placeholder", () => {
    const child: Row = { ...FILE, id: "main", parent: "src", name: "main.ts" };
    const { getByText, container } = renderTable({
      rows: [DIR, FILE, child],
      lazy: lazyWith({ kind: "loaded" }),
      expanded: { src: true },
    });
    expect(getByText("main.ts")).toBeTruthy();
    expect(container.querySelector("[data-tree-placeholder]")).toBeNull();
  });
});

describe("data-view nested table: the open gesture", () => {
  it("opens on double-click and Enter, apart from the click", () => {
    const onRowOpen = vi.fn();
    const activate = vi.fn();
    const { getByText } = renderTable({
      onRowOpen,
      rowActivation: (r) => () => activate(r),
    });
    const row = rowOf(getByText("README.md"));

    fireEvent.click(row, { detail: 1 });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(onRowOpen).not.toHaveBeenCalled();

    // The second click of a double-click is the open's, not another activate.
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowOpen.mock.calls[0]![0]).toBe(FILE);

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowOpen).toHaveBeenCalledTimes(2);
  });

  it("opens an openOnActivate row on a single click, once per double-click", () => {
    const onRowOpen = vi.fn();
    const activate = vi.fn();
    const { getByText } = renderTable({
      onRowOpen,
      rowActivation: (r) => () => activate(r),
      options: { openOnActivate: (r: Row) => r.isDir },
    });
    const dir = rowOf(getByText("src"));

    fireEvent.click(dir, { detail: 1 });
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowOpen.mock.calls[0]![0]).toBe(DIR);
    expect(activate).not.toHaveBeenCalled();

    // The rest of a double-click opens nothing more.
    fireEvent.click(dir, { detail: 2 });
    fireEvent.doubleClick(dir);
    expect(onRowOpen).toHaveBeenCalledTimes(1);

    // Other rows still activate on click.
    const file = rowOf(getByText("README.md"));
    fireEvent.click(file, { detail: 1 });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("walks the rows with the arrow keys", () => {
    const onRowOpen = vi.fn();
    const activate = vi.fn();
    const { getByText } = renderTable({
      onRowOpen,
      rowActivation: (r) => () => activate(r.id),
    });
    fireEvent.keyDown(rowOf(getByText("src")), { key: "ArrowDown" });
    expect(activate).toHaveBeenCalledWith("readme");
  });

  it("leaves rows unfocusable and inert to double-click without it", () => {
    const { getByText } = renderTable();
    expect(getByText("README.md").closest("[tabindex='0']")).toBeNull();
  });
});

describe("data-view nested table: the column header", () => {
  it("draws the field titles over the columns, and sorts from them", () => {
    const setSort = vi.fn();
    const { getByText } = renderTable({
      setSort,
      sortHeader: {
        active: [{ fieldId: "size", direction: "desc" }],
        sortable: new Set(["name", "size"]),
      },
    });
    fireEvent.click(getByText("Size"));
    expect(setSort).toHaveBeenCalledWith("size");
    // A field that does not sort is a plain title.
    fireEvent.click(getByText("Modified"));
    expect(setSort).toHaveBeenCalledTimes(1);
    expect(getByText("2 KB")).toBeTruthy();
  });
});

describe("data-view nested table: a link row", () => {
  afterEach(() => vi.restoreAllMocks());

  const treeRowOf = (label: HTMLElement) =>
    label.closest<HTMLElement>("[data-tree-row]")!;

  it("opens in place on a click, and its href in a browser tab on ⌘- / middle-click", () => {
    const open = vi.fn();
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const { getByText } = renderTable({
      rowActivation: (r) => ({
        open: () => open(r.id),
        href: () => `/files/${r.id}`,
      }),
    });
    const row = treeRowOf(getByText("README.md"));

    fireEvent.click(row, { detail: 1 });
    expect(open).toHaveBeenCalledWith("readme");
    expect(windowOpen).not.toHaveBeenCalled();

    fireEvent.click(row, { detail: 1, metaKey: true });
    fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(windowOpen).toHaveBeenCalledTimes(2);
    expect(String(windowOpen.mock.calls[0]![0])).toBe(
      `${window.location.origin}/files/readme`,
    );
  });

  it("a row whose click toggles expansion is no link", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const setExpanded = vi.fn();
    const { getByText } = renderTable({
      setExpanded,
      rowActivation: (r) => ({ open: () => {}, href: () => `/files/${r.id}` }),
      options: { expandOnActivate: (r: Row) => r.isDir },
    });
    const src = treeRowOf(getByText("src"));
    fireEvent(src, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(windowOpen).not.toHaveBeenCalled();
    fireEvent.click(src, { detail: 1 });
    expect(setExpanded).toHaveBeenCalledWith([{ id: "src", expanded: true }]);
  });
});
