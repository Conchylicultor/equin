import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { DeferredSortableList } from "@plugins/primitives/plugins/sortable-list/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { ReorderAreaContext } from "@plugins/reorder/plugins/area/web";
import { ReorderItemMiddleware } from "../internal/item-middleware";
import { ReorderItemClaimContext } from "../internal/item-claim";
import { setEditMode } from "@plugins/primitives/plugins/edit-mode-signal/web";

/**
 * The claim invariant: a contribution is a sortable item iff it was rendered as
 * an ITEM OF this area — by that area's own `renderItem` — not merely somewhere
 * underneath it. The leak this pins is a slot dispatched from INSIDE a
 * contribution (`.Dispatch` / `renderIsolated` mount no area of their own), which
 * used to inherit the ambient `ReorderAreaContext` and register `useSortable`
 * with a per-CONTRIBUTION id — N instances of one contribution, N duplicate
 * dnd-kit ids in one `DndContext`.
 */

const SORTABLE = '[aria-roledescription="sortable"]';

function contributionOf(
  id: string,
  extra?: Record<string, unknown>,
): Contribution {
  // `contributionKey()` reads `_pluginId` + `id`; nothing else is touched.
  return { _pluginId: "test.plugin", id, ...extra } as unknown as Contribution;
}

/**
 * The ambient shape a real reorder area establishes in edit mode: the area
 * context around a binding provider with the editor's drag host mounted
 * (`DeferredSortableList`, enabled). The CLAIM is deliberately NOT part of it — the list middleware
 * hands one out per `renderItem` call, which `Claimed` below stands in for.
 */
function Area({ ids, children }: { ids: string[]; children: ReactNode }) {
  return (
    <ReorderAreaContext.Provider
      value={{
        orientation: "vertical",
        onHide: () => {},
        onRemoveNode: () => {},
        ItemChrome: null,
      }}
    >
      <DeferredSortableList enabled items={ids} onMove={() => {}}>
        {children}
      </DeferredSortableList>
    </ReorderAreaContext.Provider>
  );
}

/** What the list middleware wraps each `renderItem(...)` result in. */
function Claimed({ children }: { children: ReactNode }) {
  return (
    <ReorderItemClaimContext.Provider value={true}>
      {children}
    </ReorderItemClaimContext.Provider>
  );
}

beforeEach(() => {
  // Outside edit mode no drag host is mounted, so an item wears no dnd
  // attributes — so the marker we assert on only exists in edit
  // mode. Which branch the middleware takes is independent of it.
  setEditMode(true);
});

afterEach(() => {
  setEditMode(false);
  cleanup();
});

describe("reorder item claim", () => {
  it("wraps a claimed contribution and leaves a nested unclaimed one bare", () => {
    const { container, getByTestId } = render(
      <Area ids={["test.plugin:outer"]}>
        <Claimed>
          <ReorderItemMiddleware
            slotId="area.slot"
            contribution={contributionOf("outer")}
          >
            {/* The contribution's own subtree: a nested `.Dispatch` runs the item
                middlewares again, with no claim of its own. */}
            <div data-testid="nested">
              <ReorderItemMiddleware
                slotId="nested.dispatch.slot"
                contribution={contributionOf("nested")}
              >
                <div data-testid="nested-child" />
              </ReorderItemMiddleware>
            </div>
          </ReorderItemMiddleware>
        </Claimed>
      </Area>,
    );

    // Exactly one sortable registration for the whole tree: the claimed item.
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(1);

    // …and it is the one wrapping the contribution (which contains the nest).
    const sortable = container.querySelector(SORTABLE)!;
    expect(sortable.contains(getByTestId("nested"))).toBe(true);

    // The nested dispatch rendered its child bare — no sortable inside it.
    expect(getByTestId("nested").querySelector(SORTABLE)).toBeNull();
    expect(getByTestId("nested-child")).toBeTruthy();
  });

  it("consumes the claim on a bail-out branch too", () => {
    // `excludeFromReorder` renders bare — but it must still CONSUME its claim,
    // or a slot nested inside it inherits `true` and becomes sortable.
    const { container, getByTestId } = render(
      <Area ids={[]}>
        <Claimed>
          <ReorderItemMiddleware
            slotId="area.slot"
            contribution={contributionOf("excluded", {
              excludeFromReorder: true,
            })}
          >
            <div data-testid="nested">
              <ReorderItemMiddleware
                slotId="nested.dispatch.slot"
                contribution={contributionOf("nested")}
              >
                <div data-testid="nested-child" />
              </ReorderItemMiddleware>
            </div>
          </ReorderItemMiddleware>
        </Claimed>
      </Area>,
    );

    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
    expect(getByTestId("nested-child")).toBeTruthy();
  });

  it("renders bare when an area encloses it but hands out no claim", () => {
    // The descriptor-less list path and any `renderIsolated` call: inside an
    // area's subtree, but not a member of it.
    const { container, getByTestId } = render(
      <Area ids={[]}>
        <ReorderItemMiddleware
          slotId="unclaimed.slot"
          contribution={contributionOf("unclaimed")}
        >
          <div data-testid="child" />
        </ReorderItemMiddleware>
      </Area>,
    );

    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
    expect(getByTestId("child")).toBeTruthy();
  });
});
