import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  setEditMode,
  useEditMode,
} from "@plugins/primitives/plugins/edit-mode-signal/web";
import { ItemBindingProvider } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { DeferredSortableHost } from "@plugins/primitives/plugins/sortable-list/web";
import { ReorderAreaContext } from "@plugins/reorder/plugins/area/web";
import { ReorderItemChrome } from "@plugins/reorder/plugins/editor/web";
import { ReorderItemMiddleware } from "@plugins/reorder/web";
import { ReorderItemClaim } from "@plugins/reorder/web/testing";

/**
 * The apply/edit seam's promise: an area's items are drawn by the apply side in
 * the same element chain in and out of edit mode, and the editor dresses them
 * from BESIDE (drag host) and from INSIDE ahead of the content (item chrome) —
 * so entering or leaving edit mode never remounts a contribution.
 */

const SORTABLE = '[aria-roledescription="sortable"]';

afterEach(() => {
  act(() => setEditMode(false));
  cleanup();
});

/** A contribution with state of its own: if it remounts, `n` resets. */
function Counter() {
  const [n, setN] = useState(0);
  return (
    <button data-testid="count" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

/** What the list middleware draws for one vertical area, editor included. */
function Area({ children }: { children: ReactNode }) {
  const editMode = useEditMode();
  return (
    <ReorderAreaContext.Provider
      value={{
        orientation: "vertical",
        onHide: () => {},
        onRemoveNode: () => {},
        ItemChrome: ReorderItemChrome,
      }}
    >
      <ItemBindingProvider>
        {children}
        {editMode ? (
          <DeferredSortableHost items={["test.plugin:a"]} onMove={() => {}} />
        ) : null}
      </ItemBindingProvider>
    </ReorderAreaContext.Provider>
  );
}

const contribution = {
  _pluginId: "test.plugin",
  id: "a",
} as unknown as Contribution;

describe("toggling edit mode", () => {
  it("dresses the item in place, without remounting the contribution", () => {
    const { container, getByTestId, queryByLabelText } = render(
      <Area>
        {/* The claim the list middleware hands each `renderItem` result. */}
        <ReorderItemClaim>
          <ReorderItemMiddleware slotId="area.slot" contribution={contribution}>
            <Counter />
          </ReorderItemMiddleware>
        </ReorderItemClaim>
      </Area>,
    );
    const button = getByTestId("count");
    fireEvent.click(button);
    expect(button.textContent).toBe("1");
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
    expect(queryByLabelText("Hide item")).toBeNull();

    act(() => setEditMode(true));
    // Same node, same state — and now a bound, chromed item.
    expect(getByTestId("count")).toBe(button);
    expect(button.textContent).toBe("1");
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(1);
    expect(queryByLabelText("Hide item")).not.toBeNull();
    expect(container.querySelector(SORTABLE)!.className).toContain("ring-1");

    act(() => setEditMode(false));
    expect(getByTestId("count")).toBe(button);
    expect(button.textContent).toBe("1");
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
    expect(queryByLabelText("Hide item")).toBeNull();
  });
});
