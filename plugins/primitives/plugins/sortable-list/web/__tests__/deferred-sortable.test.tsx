import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import {
  DeferredSortableItem,
  DeferredSortableList,
} from "../internal/deferred-sortable";

afterEach(cleanup);

const SORTABLE = '[aria-roledescription="sortable"]';

/** A child with state of its own: if the item remounts, `n` resets. */
function Counter({ id }: { id: string }) {
  const [n, setN] = useState(0);
  return (
    <button data-testid={`count-${id}`} onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

function List({ enabled }: { enabled: boolean }) {
  const ids = ["a", "b"];
  return (
    <DeferredSortableList enabled={enabled} items={ids} onMove={() => {}}>
      {ids.map((id) => (
        <DeferredSortableItem key={id} id={id}>
          {() => <Counter id={id} />}
        </DeferredSortableItem>
      ))}
    </DeferredSortableList>
  );
}

describe("DeferredSortableList", () => {
  it("binds no drag machinery while disabled", () => {
    const { container } = render(<List enabled={false} />);
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
  });

  it("makes every item a sortable while enabled", () => {
    const { container } = render(<List enabled />);
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(2);
  });

  it("never remounts an item when it flips", () => {
    const { container, getByTestId, rerender } = render(
      <List enabled={false} />,
    );
    const button = getByTestId("count-a");
    fireEvent.click(button);
    expect(button.textContent).toBe("1");

    rerender(<List enabled />);
    // The same node, with its state: the host bound beside the item.
    expect(getByTestId("count-a")).toBe(button);
    expect(button.textContent).toBe("1");
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(2);

    rerender(<List enabled={false} />);
    expect(getByTestId("count-a")).toBe(button);
    expect(container.querySelectorAll(SORTABLE)).toHaveLength(0);
  });

  it("throws for an item outside a deferred list", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(<DeferredSortableItem id="x">{() => null}</DeferredSortableItem>),
    ).toThrow(/outside a DeferredSortableList/);
  });
});
