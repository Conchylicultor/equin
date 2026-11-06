import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useTreeFocus } from "../internal/use-tree-focus";

afterEach(cleanup);

const probe = { holdsFocus: (): boolean => false };

function Host({ portal }: { portal: boolean }) {
  const treeFocus = useTreeFocus();
  const { onFocusCapture } = treeFocus;
  useEffect(() => {
    probe.holdsFocus = treeFocus.holdsFocus;
  });
  return (
    <div onFocusCapture={onFocusCapture}>
      <button>inside</button>
      {portal ? createPortal(<button>portaled</button>, document.body) : null}
    </div>
  );
}

describe("useTreeFocus", () => {
  it("holds focus on a DOM descendant", () => {
    render(<Host portal={false} />);
    act(() => screen.getByText("inside").focus());
    expect(probe.holdsFocus()).toBe(true);
  });

  it("holds focus on an element portaled out of the DOM subtree", () => {
    render(
      <>
        <Host portal />
        <button>elsewhere</button>
      </>,
    );
    act(() => screen.getByText("portaled").focus());
    expect(probe.holdsFocus()).toBe(true);
  });

  it("does not hold focus once it moved elsewhere", () => {
    render(
      <>
        <Host portal />
        <button>elsewhere</button>
      </>,
    );
    act(() => screen.getByText("portaled").focus());
    act(() => screen.getByText("elsewhere").focus());
    expect(probe.holdsFocus()).toBe(false);
  });

  it("does not hold focus once it fell to the body", () => {
    render(<Host portal={false} />);
    const inside = screen.getByText("inside");
    act(() => inside.focus());
    act(() => inside.blur());
    expect(probe.holdsFocus()).toBe(false);
  });
});
