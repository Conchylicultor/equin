import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { ControlPanel } from "../internal/namespace";

/**
 * A row given an `activation` is a link: a plain click opens it here, a
 * middle-click in a new browser tab — with or without `keepFocus` (which
 * selects on press). The quick-theme "Open theme editor" and the block menu's
 * "Open as page" used to run their link from `onSelect` and lost the tab.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function target() {
  const open = vi.fn();
  const link: LinkTarget = { open, href: () => "/theme" };
  return { open, link };
}

function middleClick(el: HTMLElement) {
  fireEvent.mouseDown(el, { button: 1 });
  fireEvent(el, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
}

describe.each([false, true])(
  "ControlPanel.Row activation (keepFocus=%s)",
  (keepFocus) => {
    it("middle-click opens a new browser tab, not here", () => {
      const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
      const { open, link } = target();
      render(
        <ControlPanel.Row activation={link} keepFocus={keepFocus}>
          Open theme editor
        </ControlPanel.Row>,
      );
      middleClick(screen.getByRole("button", { name: "Open theme editor" }));
      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect(String(windowOpen.mock.calls[0]![0])).toContain("/theme");
      expect(open).not.toHaveBeenCalled();
    });

    it("a plain click opens it here, once", () => {
      const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
      const { open, link } = target();
      render(
        <ControlPanel.Row activation={link} keepFocus={keepFocus}>
          Open theme editor
        </ControlPanel.Row>,
      );
      const row = screen.getByRole("button", { name: "Open theme editor" });
      fireEvent.mouseDown(row, { button: 0, detail: 1 });
      fireEvent.click(row, { button: 0, detail: 1 });
      expect(open).toHaveBeenCalledTimes(1);
      expect(windowOpen).not.toHaveBeenCalled();
    });
  },
);
