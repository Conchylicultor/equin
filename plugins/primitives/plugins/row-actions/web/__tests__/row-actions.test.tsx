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
