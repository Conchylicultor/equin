import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RowActions, rowActionsAnchor } from "../internal/row-actions";

afterEach(cleanup);

const action = <button data-testid="act">x</button>;

describe("RowActions — a hover-revealed cluster mounts when its row is reached", () => {
  it("waits for the pointer on a row with a focus stop of its own", () => {
    render(
      <div data-testid="row" className={rowActionsAnchor}>
        <button>label</button>
        <RowActions>{action}</RowActions>
      </div>,
    );
    expect(screen.queryByTestId("act")).toBeNull();
    fireEvent.pointerOver(screen.getByText("label"));
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("mounts when focus enters the row, so Tab reaches it next", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions>{action}</RowActions>
      </div>,
    );
    expect(screen.queryByTestId("act")).toBeNull();
    fireEvent.focusIn(screen.getByText("label"));
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("stays mounted once reached", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions>{action}</RowActions>
      </div>,
    );
    fireEvent.pointerOver(screen.getByText("label"));
    fireEvent.pointerOut(screen.getByText("label"));
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("mounts at once on a row Tab could not otherwise land in", () => {
    render(
      <div className={rowActionsAnchor}>
        <span>plain</span>
        <RowActions>{action}</RowActions>
      </div>,
    );
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("mounts at once with no anchor to arm it", () => {
    render(
      <div>
        <button>label</button>
        <RowActions>{action}</RowActions>
      </div>,
    );
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("never defers an in-flow or always-visible cluster", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions pin={null}>
          <button data-testid="in-flow">x</button>
        </RowActions>
        <RowActions alwaysVisible>
          <button data-testid="always">x</button>
        </RowActions>
      </div>,
    );
    expect(screen.getByTestId("in-flow")).toBeTruthy();
    expect(screen.getByTestId("always")).toBeTruthy();
  });
});

describe('RowActions chrome="float" — a chip over a picture', () => {
  it("draws the buttons on a float-surface chip that hides while it holds no control", () => {
    render(
      <div className={rowActionsAnchor}>
        <RowActions pin={null} alwaysVisible chrome="float">
          <button data-testid="act">x</button>
        </RowActions>
      </div>,
    );
    const chip = screen.getByTestId("act").parentElement!;
    expect(chip.className).toContain("bg-float-fill");
    // Collapses when nothing renders: hidden unless it holds a control (a
    // slot's layout-neutral wrappers alone are not content).
    expect(chip.className).toContain("not-has-[button,a[href],input]:hidden");
  });

  it("a pinned float chip paints no scrim (its own backdrop replaces it)", () => {
    render(
      <div className={rowActionsAnchor}>
        <span>plain</span>
        <RowActions pin="top-right" chrome="float">
          <button data-testid="act">x</button>
        </RowActions>
      </div>,
    );
    const pin = screen.getByTestId("act").closest(".absolute")!;
    expect(pin.getAttribute("style") ?? "").not.toContain("scrim");
    expect(screen.getByTestId("act").parentElement!.className).toContain(
      "bg-float-fill",
    );
  });

  it("an unpinned hover-revealed float chip still waits for its row", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions pin={null} chrome="float">
          <button data-testid="act">x</button>
        </RowActions>
      </div>,
    );
    expect(screen.queryByTestId("act")).toBeNull();
    fireEvent.pointerOver(screen.getByText("label"));
    expect(screen.getByTestId("act")).toBeTruthy();
  });
});
