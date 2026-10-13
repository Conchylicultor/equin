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
import { TreeView } from "../components/tree-view";

/**
 * The three tree extensions a file browser needs, through the data-view tree:
 * lazily-listed children (chevron before any child, a load request for every
 * open unlisted node, loading / failed / empty placeholder rows), the open
 * gesture (double-click / Enter, distinct from the click), and aligned columns
 * under a sortable header.
 */

const plugin = {
  id: "data-view-tree-lazy-open-aligned-test",
  description: "tree lazy/open/aligned fixture",
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

function renderTree(
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
      <TreeView {...(p as DataViewRenderProps<unknown>)} />
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

describe("data-view tree: lazy children", () => {
  const lazyWith = (state: TreeChildrenState, load = vi.fn()) => ({
    hasChildren: (r: Row) => r.isDir,
    state: () => state,
    load,
  });

  it("gives an unlisted folder a live chevron, and not a file", () => {
    const setExpanded = vi.fn();
    const { getByText } = renderTree({
      lazy: lazyWith({ kind: "unloaded" }),
      setExpanded,
    });
    const chevronOf = (label: string) =>
      getByText(label)
        .closest("[data-tree-row]")!
        .querySelector<HTMLElement>("button[aria-label='Expand']");
    // A row with children (loaded or not) shows its chevron at rest; a leaf
    // cannot expand, so it has no chevron at all.
    expect(chevronOf("src")!.className).not.toContain("pointer-events-none");
    expect(chevronOf("README.md")).toBeNull();
    fireEvent.click(chevronOf("src")!);
    expect(setExpanded).toHaveBeenCalledWith([{ id: "src", expanded: true }]);
  });

  it("asks an open, unlisted folder for its children once, and shows it loading", () => {
    const load = vi.fn();
    // An expand map restored on reload: no gesture happened, the folder is open.
    const { container, rerenderWith } = renderTree({
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
    renderTree({ lazy: lazyWith({ kind: "unloaded" }, load) });
    expect(load).not.toHaveBeenCalled();
  });

  it("renders a failed listing with its message and a Retry", () => {
    const retry = vi.fn();
    const { getByRole } = renderTree({
      lazy: lazyWith({ kind: "failed", message: "Permission denied", retry }),
      expanded: { src: true },
    });
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("Permission denied");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("says a listed folder with no children is empty", () => {
    const { getByText } = renderTree({
      lazy: lazyWith({ kind: "loaded" }),
      expanded: { src: true },
    });
    expect(getByText("Empty")).toBeTruthy();
  });

  it("renders loaded children with no placeholder", () => {
    const child: Row = { ...FILE, id: "main", parent: "src", name: "main.ts" };
    const { getByText, container } = renderTree({
      rows: [DIR, FILE, child],
      lazy: lazyWith({ kind: "loaded" }),
      expanded: { src: true },
    });
    expect(getByText("main.ts")).toBeTruthy();
    expect(container.querySelector("[data-tree-placeholder]")).toBeNull();
  });
});

describe("data-view tree: the open gesture", () => {
  it("opens on double-click and Enter, apart from the click", () => {
    const onRowOpen = vi.fn();
    const activate = vi.fn();
    const { getByText } = renderTree({
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
    const { getByText } = renderTree({
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

    // A double-click whose first click opened another row does not open this one.
    const file = rowOf(getByText("README.md"));
    fireEvent.click(dir, { detail: 1 });
    fireEvent.click(file, { detail: 2 });
    fireEvent.doubleClick(file);
    expect(onRowOpen).toHaveBeenCalledTimes(2);
    expect(onRowOpen.mock.calls[1]![0]).toBe(DIR);

    // Other rows still activate on click.
    fireEvent.click(file, { detail: 1 });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("leaves rows unfocusable and inert to double-click without it", () => {
    const { getByText } = renderTree();
    expect(getByText("README.md").closest("[tabindex='0']")).toBeNull();
  });
});

describe("data-view tree: aligned columns", () => {
  it("draws a header over fixed-width cells, and sorts from it", () => {
    const setSort = vi.fn();
    const { container, getByRole, getByText } = renderTree({
      options: { columns: "aligned" },
      setSort,
      sortHeader: {
        active: [{ fieldId: "size", direction: "desc" }],
        sortable: new Set(["name", "size"]),
      },
    });
    const header = container.querySelector("[data-tree-column-header]")!;
    expect(header.textContent).toContain("Name");
    expect(header.textContent).toContain("Modified");
    expect(header.textContent).toContain("Size");

    // Every row's cells share the header's widths.
    const modified = container.querySelectorAll<HTMLElement>(
      "[data-aligned-cell='modified']",
    );
    expect(modified).toHaveLength(2);
    for (const cell of modified) expect(cell.style.width).toBe("96px");
    const sizes = container.querySelectorAll<HTMLElement>(
      "[data-aligned-cell='size']",
    );
    for (const cell of sizes) expect(cell.style.width).toBe("80px");
    expect(getByText("2 KB")).toBeTruthy();

    // Sortable titles toggle the view's sort; the active one says which way.
    const sizeTitle = getByRole("button", { name: "Sort by Size" });
    expect(sizeTitle.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(sizeTitle);
    expect(setSort).toHaveBeenCalledWith("size");
    // A field that does not sort is a plain title.
    expect(header.querySelector("[data-aligned-header='modified']")).toBeNull();
  });

  it("keeps the trailing chips without the option", () => {
    const { container } = renderTree();
    expect(container.querySelector("[data-tree-column-header]")).toBeNull();
    expect(container.querySelector("[data-aligned-cell]")).toBeNull();
  });
});

describe("data-view tree: a link row", () => {
  afterEach(() => vi.restoreAllMocks());

  const treeRowOf = (label: HTMLElement) =>
    label.closest<HTMLElement>("[data-tree-row]")!;

  it("opens in place on a click, and its href in a browser tab on ⌘- / middle-click", () => {
    const open = vi.fn();
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const { getByText } = renderTree({
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
    const { getByText } = renderTree({
      setExpanded,
      rowActivation: (r) => ({ open: () => {}, href: () => `/files/${r.id}` }),
      options: { expandOnActivate: (r: Row) => r.isDir },
    });
    fireEvent(
      treeRowOf(getByText("src")),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
