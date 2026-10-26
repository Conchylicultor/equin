/**
 * The window's estimate for rows it has not measured is the size the first
 * row it measured turned out to have — the caller's `estimateSize` is only a
 * first guess. A wrong one shifts the rows below every row first drawn and,
 * for a row first drawn above the reader, has the virtualizer scroll by the
 * difference: the list jolts a row at a time.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useVirtualRows } from "../internal/virtual-rows";

/** The window's total size, per render. */
const totals: number[] = [];

function List(props: { items: string[] }): ReactElement {
  const { measureRef, virtualizer, virtualItems, totalSize } = useVirtualRows({
    items: props.items,
    estimateSize: 36,
    getKey: (x) => x,
  });
  totals.push(totalSize);
  return (
    <div data-scroller style={{ overflowY: "auto" }}>
      <div ref={measureRef} style={{ height: totalSize }}>
        {virtualItems.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            data-row
            ref={virtualizer.measureElement}
          >
            {props.items[vi.index]}
          </div>
        ))}
      </div>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("useVirtualRows — the estimate is learned", () => {
  it("rows never measured are estimated at the first measured row's size, not the guess", () => {
    // The scroller shows 300 px; a row is 31 px. Stubbed through both box
    // reads: virtual-core sizes the scroller by its client box (3.19.7+) and
    // a row by its rect or offset box.
    const heightOf = (el: Element) =>
      el.hasAttribute("data-row")
        ? 31
        : el.hasAttribute("data-scroller")
          ? 300
          : 0;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const h = heightOf(this);
        return { top: 0, bottom: h, height: h, width: 100 } as DOMRect;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return heightOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return heightOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const items = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const view = render(<List items={items} />);
    // Grow the list: the rows appended are estimated at the learned 31 px.
    view.rerender(<List items={[...items, "r100", "r101"]} />);
    expect(totals.at(-1)).toBe(102 * 31);
  });
});
