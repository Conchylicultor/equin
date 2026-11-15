import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activationProps } from "../internal/link-gesture";

// The same props spread onto a real `<a href>`: the browser already owns the
// anchor's "elsewhere" gestures, so a plain click must run the in-app open and
// cancel the document navigation, and a modified click must be left alone.
function setup(isolate = false) {
  const target = { open: vi.fn(), href: vi.fn(() => "/pages") };
  const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  render(
    <a href="/pages" {...activationProps(target, { isolate })}>
      Pages
    </a>,
  );
  return { target, windowOpen, link: screen.getByText("Pages") };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("activationProps on a real <a href>", () => {
  for (const isolate of [false, true]) {
    describe(isolate ? "isolated" : "plain", () => {
      it("a plain click opens in place and cancels the navigation", () => {
        const { target, windowOpen, link } = setup(isolate);
        const notCancelled = fireEvent.click(link);
        expect(notCancelled).toBe(false);
        expect(target.open).toHaveBeenCalledWith({ keepOthers: false });
        expect(windowOpen).not.toHaveBeenCalled();
      });

      it("an ⌥-click opens in place keeping the others", () => {
        const { target, link } = setup(isolate);
        expect(fireEvent.click(link, { altKey: true })).toBe(false);
        expect(target.open).toHaveBeenCalledWith({ keepOthers: true });
      });

      for (const mod of ["metaKey", "ctrlKey", "shiftKey"] as const) {
        it(`a ${mod} click is left to the browser`, () => {
          const { target, windowOpen, link } = setup(isolate);
          expect(fireEvent.click(link, { [mod]: true })).toBe(true);
          expect(target.open).not.toHaveBeenCalled();
          expect(target.href).not.toHaveBeenCalled();
          expect(windowOpen).not.toHaveBeenCalled();
        });
      }

      it("a middle click is left to the browser", () => {
        const { target, windowOpen, link } = setup(isolate);
        expect(fireEvent.mouseDown(link, { button: 1 })).toBe(true);
        expect(
          fireEvent(
            link,
            new MouseEvent("auxclick", {
              button: 1,
              bubbles: true,
              cancelable: true,
            }),
          ),
        ).toBe(true);
        expect(target.open).not.toHaveBeenCalled();
        expect(windowOpen).not.toHaveBeenCalled();
      });
    });
  }
});

describe("activationProps on a <button>", () => {
  it("a ⌘-click still opens a browser tab itself", () => {
    const target = { open: vi.fn(), href: vi.fn(() => "/pages") };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <button type="button" {...activationProps(target)}>
        Pages
      </button>,
    );
    fireEvent.click(screen.getByText("Pages"), { metaKey: true });
    expect(target.open).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledTimes(1);
  });
});
