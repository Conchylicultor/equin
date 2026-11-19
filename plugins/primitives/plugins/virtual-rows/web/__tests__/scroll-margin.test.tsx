/**
 * The windowed region's offset in its scroller (`scrollMargin`) follows the
 * content above it: a paged list's far pages swapped for a placeholder above
 * the rows (or back) change that offset together with the rows, and a window
 * still reading the offset it had at mount would draw rows where they no
 * longer are — so it is re-measured in the very commit that changes the
 * items, before paint (no observer callback awaited). Content above can also
 * resize with the rows unchanged (another section's placeholders above this
 * one): a resize of a box above the region re-measures it too — the box there
 * now, not one it replaced.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useVirtualRows } from "../internal/virtual-rows";

let margins: number[] = [];
/** Per render: may a size the window learns scroll the reader (`adjusts`) or not (`holds`)? */
let gates: ("adjusts" | "holds")[] = [];

function Probe(props: {
  items: string[];
  above: number;
  /** The above box's key: a new one remounts it (a toolbar band redrawn). */
  band?: string;
}): ReactElement {
  const { measureRef, scrollMargin, virtualizer } = useVirtualRows({
    items: props.items,
    estimateSize: 20,
    getKey: (x) => x,
  });
  margins.push(scrollMargin);
  gates.push(
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange === undefined
      ? "adjusts"
      : "holds",
  );
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <div
        key={props.band}
        data-testid="above"
        style={{ height: props.above }}
      />
      <div data-testid="sizer" ref={measureRef} />
    </div>
  );
}

/** A ResizeObserver the test drives: `resize(el)` reports `el` to whoever watches it. */
class DrivenResizeObserver {
  static all = new Set<DrivenResizeObserver>();
  watched = new Set<Element>();
  constructor(private cb: ResizeObserverCallback) {
    DrivenResizeObserver.all.add(this);
  }
  observe(el: Element): void {
    this.watched.add(el);
  }
  unobserve(el: Element): void {
    this.watched.delete(el);
  }
  disconnect(): void {
    this.watched.clear();
    DrivenResizeObserver.all.delete(this);
  }
  static resize(el: Element): void {
    for (const ro of DrivenResizeObserver.all) {
      if (!ro.watched.has(el)) continue;
      ro.cb(
        [{ target: el } as ResizeObserverEntry],
        ro as unknown as ResizeObserver,
      );
    }
  }
}

/** The sizer sits below the `above` box; the scroller is at the top. */
function layOutBelowAbove(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const top =
        this.getAttribute("data-testid") === "sizer"
          ? parseFloat(
              (document.querySelector('[data-testid="above"]') as HTMLElement)
                .style.height,
            )
          : 0;
      return { top, bottom: top, height: 0 } as DOMRect;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  DrivenResizeObserver.all.clear();
  cleanup();
  margins = [];
  gates = [];
});

describe("useVirtualRows — scrollMargin", () => {
  it("is re-measured in the commit that changes the items — no resize report awaited — so content resized above them moves the window with them", () => {
    // An observer that never reports on its own: only the commit measures.
    vi.stubGlobal("ResizeObserver", DrivenResizeObserver);
    layOutBelowAbove();
    const { rerender } = render(
      <Probe items={["a", "b", "c", "d"]} above={100} />,
    );
    expect(margins.at(-1)).toBe(100);
    // Two rows swapped for a taller placeholder above the region.
    gates = [];
    margins = [];
    rerender(<Probe items={["c", "d"]} above={180} />);
    expect(margins.at(-1)).toBe(180);
    // The commit drawing the new items against the old margin learns sizes
    // that scroll nobody (its window is not where the rows are); once the
    // margin is measured for them, sizes adjust again.
    expect([margins[0], gates[0]]).toEqual([100, "holds"]);
    expect([margins.at(-1), gates.at(-1)]).toEqual([180, "adjusts"]);
  });

  it("is re-measured when a box above the region resizes with the items unchanged", () => {
    vi.stubGlobal("ResizeObserver", DrivenResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    layOutBelowAbove();
    const items = ["a", "b", "c", "d"];
    const { rerender } = render(<Probe items={items} above={100} />);
    expect(margins.at(-1)).toBe(100);
    // The same items, a taller box above them — which the browser reports
    // as a resize.
    rerender(<Probe items={items} above={160} />);
    expect(margins.at(-1)).toBe(100);
    act(() =>
      DrivenResizeObserver.resize(
        document.querySelector('[data-testid="above"]')!,
      ),
    );
    expect(margins.at(-1)).toBe(160);
  });

  it("follows a box above the region that is replaced with the items unchanged", async () => {
    vi.stubGlobal("ResizeObserver", DrivenResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    layOutBelowAbove();
    const items = ["a", "b", "c", "d"];
    const { rerender } = render(
      <Probe items={items} above={100} band="wide" />,
    );
    const old = document.querySelector('[data-testid="above"]')!;
    // The band remounts (the pane narrowed): same items, same height.
    rerender(<Probe items={items} above={100} band="narrow" />);
    await act(async () => {});
    const band = document.querySelector('[data-testid="above"]')!;
    expect(band).not.toBe(old);
    const watched = [...DrivenResizeObserver.all].flatMap((ro) => [
      ...ro.watched,
    ]);
    expect(watched).toContain(band);
    expect(watched).not.toContain(old);
    // The new band grows on its own (no render): the margin follows it.
    (band as HTMLElement).style.height = "160px";
    act(() => DrivenResizeObserver.resize(band));
    expect(margins.at(-1)).toBe(160);
  });
});
