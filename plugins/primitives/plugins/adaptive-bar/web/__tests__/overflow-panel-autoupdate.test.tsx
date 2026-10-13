import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OverflowPanel } from "../internal/overflow-panel";

/**
 * The overflow panel is always mounted (it holds live relocated DOM), so its
 * Floating UI `autoUpdate` — which watches the anchor for every scroll, resize
 * and layout shift — must run only while the panel is OPEN. Before, a closed
 * `display: none` panel was repositioned on every layout shift of the page.
 */

const autoUpdateCalls = vi.hoisted(() => ({ count: 0, stops: 0 }));

vi.mock("@floating-ui/react-dom", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@floating-ui/react-dom")>();
  return {
    ...actual,
    autoUpdate: (...args: Parameters<typeof actual.autoUpdate>) => {
      autoUpdateCalls.count += 1;
      const stop = actual.autoUpdate(...args);
      return () => {
        autoUpdateCalls.stops += 1;
        stop();
      };
    },
  };
});

afterEach(() => {
  cleanup();
  autoUpdateCalls.count = 0;
  autoUpdateCalls.stops = 0;
});

function panel(open: boolean, anchor: HTMLElement) {
  return (
    <OverflowPanel
      open={open}
      anchor={anchor}
      label="More"
      dockRef={() => {}}
      dockAttrs={{}}
      onDismiss={() => {}}
    />
  );
}

describe("OverflowPanel auto-update", () => {
  it("does not track the anchor while closed, and does once opened", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    const { rerender } = render(panel(false, anchor));
    expect(autoUpdateCalls.count).toBe(0);

    rerender(panel(true, anchor));
    expect(autoUpdateCalls.count).toBe(1);

    // Closing stops the tracking again.
    rerender(panel(false, anchor));
    expect(autoUpdateCalls.stops).toBe(1);

    anchor.remove();
  });
});
