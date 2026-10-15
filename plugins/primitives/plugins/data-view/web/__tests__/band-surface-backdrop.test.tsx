import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DataViewReserve } from "../../core";
import { BandSurface } from "../components/band-surface";
import type { DataViewControlsContextValue } from "../components/controls/controls-context";

/**
 * The overlay backdrop: the backdrop view keeps ONE mount whichever view is
 * active, and any other view floats over it as a card whose right edge yields
 * to the surface's `reserve`.
 */

function surface(backdrop?: {
  panel: boolean;
  reserve?: DataViewReserve;
}): ReactNode {
  return (
    <BandSurface
      overlay
      aside={undefined}
      fullBleed={false}
      controls={{} as DataViewControlsContextValue}
      band={() => <div data-testid="band" />}
      backdrop={
        backdrop === undefined
          ? undefined
          : { node: <div data-testid="backdrop" />, ...backdrop }
      }
    >
      <div data-testid="body" />
    </BandSurface>
  );
}

/** The floating card's positioned layer: the nearest ancestor with an inset. */
function cardLayer(): HTMLElement {
  let node: HTMLElement | null = screen.getByTestId("body");
  while (node !== null && node.style.bottom === "") node = node.parentElement;
  if (node === null) throw new Error("the body is not inside a card layer");
  return node;
}

afterEach(cleanup);

describe("BandSurface backdrop", () => {
  it("keeps the backdrop mounted while the body's card comes and goes", () => {
    const { rerender } = render(surface({ panel: false }));
    const backdrop = screen.getByTestId("backdrop");
    // The active view IS the backdrop: no card, no second body.
    expect(screen.queryByTestId("body")).toBeNull();

    rerender(surface({ panel: true }));
    expect(screen.getByTestId("body")).toBeTruthy();
    expect(screen.getByTestId("backdrop")).toBe(backdrop);

    rerender(surface({ panel: false }));
    expect(screen.getByTestId("backdrop")).toBe(backdrop);
  });

  it("floats the body in a card that stops short of the reserved edge", () => {
    const { rerender } = render(surface({ panel: true }));
    expect(cardLayer().style.right).toContain("0px");
    // The card's own scroller: its sticky headers pin at its top.
    expect(
      cardLayer()
        .querySelector<HTMLElement>("[style*='--dv-header-offset']")!
        .style.getPropertyValue("--dv-header-offset"),
    ).toBe("0px");

    rerender(surface({ panel: true, reserve: { right: "352px" } }));
    expect(cardLayer().style.right).toContain("352px");
  });

  it("lays the body out as before without a backdrop", () => {
    render(surface());
    expect(screen.queryByTestId("backdrop")).toBeNull();
    expect(cardLayer.bind(null)).toThrow();
  });
});
