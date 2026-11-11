import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  useMediaQuery,
  useOwnedElement,
  useViewportSize,
} from "../internal/browser-value";

describe("browser values, live", () => {
  it("follows the window's size on resize", () => {
    function C() {
      const { width, height } = useViewportSize();
      return <p>{`${width}x${height}`}</p>;
    }
    render(<C />);
    expect(
      screen.getByText(`${window.innerWidth}x${window.innerHeight}`),
    ).toBeTruthy();
    act(() => {
      window.innerWidth = 640;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByText(`640x${window.innerHeight}`)).toBeTruthy();
  });

  it("follows a media query's change events", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    function C() {
      return (
        <p>{String(useMediaQuery("(prefers-color-scheme: dark)", false))}</p>
      );
    }
    const { unmount } = render(<C />);
    expect(screen.getByText("false")).toBeTruthy();
    act(() => {
      matches = true;
      for (const l of listeners) l();
    });
    expect(screen.getByText("true")).toBeTruthy();
    unmount();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("mints an owned element once", () => {
    const create = vi.fn((doc: Document) => doc.createElement("div"));
    const seen = new Set<Element>();
    function C({ n }: { n: number }) {
      seen.add(useOwnedElement("box", create));
      return <p>{n}</p>;
    }
    const { rerender } = render(<C n={1} />);
    rerender(<C n={2} />);
    expect(seen.size).toBe(1);
  });
});
