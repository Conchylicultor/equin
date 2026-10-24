import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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

  it("never defers an in-flow cluster without a reserve, or an always-visible one", () => {
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

describe("RowActions pin={null} reserve — an in-flow cluster that holds its box", () => {
  /** The outermost node of the mounted cluster: the Stack around the buttons
   *  (ControlSizeProvider draws no element). */
  const mountedBox = () => screen.getByTestId("act").parentElement!;
  const placeholder = () => screen.getByLabelText("Actions");

  it("waits for its row, holding the same box (classes and size) it mounts into", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions pin={null} reserve={4} className="ml-auto">
          {action}
        </RowActions>
      </div>,
    );
    expect(screen.queryByTestId("act")).toBeNull();
    const before = placeholder();
    const beforeClass = before.className;
    const beforeStyle = before.getAttribute("style");
    expect(beforeStyle).toContain(
      "min-inline-size: calc(4 * var(--control-height-xs))",
    );
    expect(beforeStyle).toContain("min-block-size: var(--control-height-xs)");
    expect(before.children).toHaveLength(0);

    fireEvent.pointerOver(screen.getByText("label"));
    expect(screen.queryByLabelText("Actions")).toBeNull();
    expect(mountedBox().className).toBe(beforeClass);
    expect(mountedBox().getAttribute("style")).toBe(beforeStyle);
    expect(mountedBox().className).toContain("ml-auto");
    expect(mountedBox().className).toContain("justify-end");
  });

  it("a float holds its one-line box: floated, line-tall, no control-tall floor", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions pin={null} float reserve={5}>
          {action}
        </RowActions>
        prose
      </div>,
    );
    const before = placeholder();
    expect(before.className).toContain("float-right");
    expect(before.className).toContain("h-lh");
    expect(before.getAttribute("style")).not.toContain("min-block-size");
    const beforeClass = before.className;
    const beforeStyle = before.getAttribute("style");
    fireEvent.pointerOver(screen.getByText("label"));
    expect(mountedBox().className).toBe(beforeClass);
    expect(mountedBox().getAttribute("style")).toBe(beforeStyle);
  });

  it("defers even on a row with no other focus stop: the placeholder is one", () => {
    render(
      <div className={rowActionsAnchor}>
        <span>plain prose</span>
        <RowActions pin={null} float reserve={5}>
          {action}
        </RowActions>
      </div>,
    );
    expect(screen.queryByTestId("act")).toBeNull();
    expect(placeholder().tabIndex).toBe(0);
  });

  it("Tab landing on the placeholder mounts the cluster and hands focus to its first button", () => {
    render(
      <div className={rowActionsAnchor}>
        <span>plain prose</span>
        <RowActions pin={null} reserve={4}>
          <button data-testid="first">a</button>
          <button data-testid="last">b</button>
        </RowActions>
      </div>,
    );
    act(() => placeholder().focus());
    expect(document.activeElement).toBe(screen.getByTestId("first"));
  });

  it("Shift+Tab coming back from after the row hands focus to the last button", () => {
    render(
      <>
        <div className={rowActionsAnchor}>
          <span>plain prose</span>
          <RowActions pin={null} reserve={4}>
            <button data-testid="first">a</button>
            <button data-testid="last">b</button>
          </RowActions>
        </div>
        <button data-testid="after">after</button>
      </>,
    );
    act(() => screen.getByTestId("after").focus());
    act(() => placeholder().focus());
    expect(document.activeElement).toBe(screen.getByTestId("last"));
  });

  it("an always-visible reserved cluster mounts at once", () => {
    render(
      <div className={rowActionsAnchor}>
        <button>label</button>
        <RowActions pin={null} alwaysVisible reserve={4}>
          {action}
        </RowActions>
      </div>,
    );
    expect(screen.getByTestId("act")).toBeTruthy();
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
