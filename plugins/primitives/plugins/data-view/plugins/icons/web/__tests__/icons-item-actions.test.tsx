import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineItemActions,
  type DataViewRenderProps,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconsView } from "../components/icons-view";

/** One `defineItemActions` contribution (the factory's call argument). */
type ItemActionContribution<T> = Parameters<
  ReturnType<typeof defineItemActions<T>>
>[0];

// A tile's item actions sit on its top-right corner, routed through the shared
// `RowActions` primitive (its reveal, its float chip) — asserted by the
// classes the primitive puts on the nodes it owns, like the gallery's tests.

/** Class selector for the outermost node of a hover-revealed cluster. */
const REVEALED = ".group-hover\\/row-actions\\:opacity-100";
/** A float chip (`RowActions chrome="float"`). */
const CHIP = ".bg-float-fill";

type Row = { id: string; name: string; on: boolean };

const name: FieldDef<Row> = {
  id: "name",
  label: "Name",
  type: "text",
  value: (r) => r.name,
  primary: true,
};

const useOn = (row: Row) => row.on;

function renderIcons(
  contributions: Omit<ItemActionContribution<Row>, "component">[] | null,
  row: Row,
  onAction = vi.fn(),
  activate = vi.fn(),
) {
  const Actions = defineItemActions<Row>();
  const plugin = {
    id: "icons-item-actions-test",
    description: "icons item-action fixture",
    contributions: (contributions ?? []).map((c) =>
      Actions({
        ...c,
        component: ({ row: r }: ItemActionProps<Row>) => (
          <button data-testid={c.id} onClick={() => onAction(c.id, r.id)}>
            {c.id}
          </button>
        ),
      }),
    ),
    slots: { actions: Actions },
  } as unknown as LoadedPlugin;
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    placement: {},
    rows: [row],
    fields: [name],
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
    itemActions: contributions === null ? undefined : Actions,
    rowActivation: () => activate,
    options: undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <IconsView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

afterEach(cleanup);

const OFF: Row = { id: "a", name: "alpha", on: false };
const ON: Row = { id: "a", name: "alpha", on: true };

describe("icons view item actions", () => {
  it("draws no corner when the surface has no item actions", () => {
    const u = renderIcons(null, OFF);
    const tile = u.container.querySelector("[data-row-key='a']")!;
    expect(tile.className).not.toContain("group/row-actions");
    expect(u.container.querySelector(CHIP)).toBeNull();
  });

  it("a revealed action is on the tile's hover-revealed float chip", () => {
    const u = renderIcons([{ id: "install" }], OFF);
    const tile = u.container.querySelector("[data-row-key='a']")!;
    // The whole tile is the reveal's hover group.
    expect(tile.className).toContain("group/row-actions");
    fireEvent.pointerOver(u.getByText("alpha"));
    const action = u.getByTestId("install");
    expect(action.closest(REVEALED)).not.toBeNull();
    expect(action.closest(CHIP)).not.toBeNull();
    expect(tile.contains(action)).toBe(true);
  });

  it("an active action rests at the corner; a persistent one always does", () => {
    const on = renderIcons([{ id: "pin", useActive: useOn }], ON);
    expect(on.getByTestId("pin").closest(REVEALED)).toBeNull();
    expect(on.getByTestId("pin").closest(CHIP)).not.toBeNull();
    cleanup();
    const keep = renderIcons([{ id: "keep", zone: "persistent" }], OFF);
    expect(keep.getByTestId("keep").closest(REVEALED)).toBeNull();
  });

  it("a press on an action runs it, not the tile's activation", () => {
    const onAction = vi.fn();
    const activate = vi.fn();
    const u = renderIcons([{ id: "install" }], OFF, onAction, activate);
    fireEvent.pointerOver(u.getByText("alpha"));
    fireEvent.click(u.getByTestId("install"));
    expect(onAction).toHaveBeenCalledWith("install", "a");
    expect(activate).not.toHaveBeenCalled();
  });
});
