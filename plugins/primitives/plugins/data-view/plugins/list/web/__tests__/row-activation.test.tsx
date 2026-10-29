import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  DataViewRenderProps,
  FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ListView } from "../components/list-view";

/**
 * Per-row activation, asserted on the DOM SHAPE rather than on the callback.
 *
 * The defect this locks down was invisible to a handler-level test: the list
 * passed `onClick={() => onRowActivate?.(row)}`, a closure that is never null,
 * so `Row` inferred a `<button>` for every row — and `Row` renders `renderRow`
 * children INSIDE that button. Any interactive content in a row body was a
 * `<button>` inside a `<button>`: invalid DOM, with the outer row swallowing the
 * click. The handler fired correctly the whole time.
 */

const plugin = {
  id: "data-view-list-row-activation-test",
  description: "list row-activation fixture",
  contributions: [],
} as unknown as LoadedPlugin;

type Row = { id: string; name: string; kind: string };

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
];

const BUILD: Row = { id: "b1", name: "build row", kind: "build" };
const BACKUP: Row = { id: "k1", name: "backup row", kind: "backup" };

function renderList(over: Partial<DataViewRenderProps<Row>>) {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: [BUILD, BACKUP],
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
    options: undefined,
    ...over,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as unknown as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

/** The row element that owns `text` — the nearest button, or its container. */
function rowOf(el: HTMLElement): HTMLElement {
  const button = el.closest("button");
  return (button ?? el.closest("[class]")) as HTMLElement;
}

afterEach(cleanup);

describe("list row activation", () => {
  it("renders NO button for a row that does not activate", () => {
    const { getByText, container } = renderList({
      rowActivation: (r) => (r.kind === "build" ? () => {} : undefined),
    });

    // The build row is a button; the backup row is not, and there is exactly one
    // button in the whole list.
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(getByText("build row").closest("button")).not.toBeNull();
    expect(getByText("backup row").closest("button")).toBeNull();
  });

  it("renders no button at all when nothing activates", () => {
    const { container } = renderList({ rowActivation: () => undefined });
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("lets a control inside a non-activating row's body be clicked", () => {
    // The whole point of the per-row shape: a row body holding a real control.
    // Nested in a `<button>` this is invalid DOM and the row eats the press.
    const granted = vi.fn();
    const { getByRole, container } = renderList({
      rowActivation: () => undefined,
      options: {
        renderRow: (r: Row) => (
          <span>
            {r.name}
            {r.kind === "backup" ? (
              <button type="button" onClick={granted}>
                Grant access
              </button>
            ) : null}
          </span>
        ),
      },
    });

    const control = getByRole("button", { name: "Grant access" });
    // It is not nested inside another button — the DOM claim, not the callback.
    expect(control.parentElement?.closest("button")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);

    fireEvent.click(control);
    expect(granted).toHaveBeenCalledTimes(1);
  });

  it("fires the row's own handler when it does activate", () => {
    const activate = vi.fn();
    const { getByText } = renderList({
      rowActivation: (r) =>
        r.kind === "build" ? () => activate(r.id) : undefined,
    });

    fireEvent.click(rowOf(getByText("build row")));
    expect(activate).toHaveBeenCalledWith("b1");

    // And the non-activating row's click reaches nothing.
    fireEvent.click(rowOf(getByText("backup row")));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  describe("a link row", () => {
    function linkList() {
      const open = vi.fn();
      const windowOpen = vi
        .spyOn(window, "open")
        .mockImplementation(() => null);
      const utils = renderList({
        rowActivation: (r) =>
          r.kind === "build"
            ? { open: () => open(r.id), href: () => `/runs/${r.id}` }
            : undefined,
      });
      const row = rowOf(utils.getByText("build row"));
      return { open, windowOpen, row, utils };
    }

    afterEach(() => vi.restoreAllMocks());

    it("opens in place on a plain click", () => {
      const { open, windowOpen, row } = linkList();
      fireEvent.click(row);
      expect(open).toHaveBeenCalledWith("b1");
      expect(windowOpen).not.toHaveBeenCalled();
    });

    it("opens its href in a new browser tab on ⌘-click and middle-click, staying put", () => {
      const { open, windowOpen, row } = linkList();
      fireEvent.click(row, { metaKey: true });
      fireEvent.click(row, { ctrlKey: true });
      fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(open).not.toHaveBeenCalled();
      expect(windowOpen).toHaveBeenCalledTimes(3);
      for (const call of windowOpen.mock.calls) {
        expect(String(call[0])).toBe(`${window.location.origin}/runs/b1`);
        expect(call[1]).toBe("_blank");
      }
    });

    it("is still a single button, and its non-link neighbour still none", () => {
      const { utils } = linkList();
      expect(utils.container.querySelectorAll("button")).toHaveLength(1);
      expect(utils.getByText("backup row").closest("button")).toBeNull();
    });
  });
});
