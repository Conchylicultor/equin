import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OverflowPanel } from "../internal/overflow-panel";

/**
 * The bar's region attributes (its theme scope) are stamped OUTSIDE the panel
 * surface, never inside it. A theme-scope root resets every surface colour role
 * (`--hover-fill`, `--selected-fill`, …) to the canvas's, so a scope stamped on
 * the dock inside the panel undid the panel's own: in Mist every parked row
 * hovered to the popover's own colour.
 */

afterEach(cleanup);

describe("OverflowPanel region attributes", () => {
  it("stamps the bar's theme scope on the overlay root, outside the panel", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    let dock: HTMLElement | null = null;
    render(
      <OverflowPanel
        span={null}
        popupAttrs={{}}
        open
        anchor={anchor}
        label="More"
        dockRef={(el) => {
          dock = el;
        }}
        regionAttrs={{ "data-theme-scope": "app:test" }}
        hasOpenChildPopup={() => false}
        onDismiss={() => {}}
      />,
    );
    const panel = document.querySelector("[data-overlay-panel]");
    expect(panel).not.toBeNull();
    expect(panel?.closest('[data-theme-scope="app:test"]')).not.toBeNull();
    expect(panel?.hasAttribute("data-theme-scope")).toBe(false);
    expect(panel?.querySelector("[data-theme-scope]")).toBeNull();
    expect(dock).not.toBeNull();
  });

  it("nests a region-only sub-theme INSIDE the app scope, so the panel keeps the app's colours", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <OverflowPanel
        span={null}
        popupAttrs={{
          "data-theme-scope": "app:site",
          "data-color-scheme": "dark",
        }}
        open
        anchor={anchor}
        label="Menu"
        dockRef={() => {}}
        regionAttrs={{
          "data-theme-scope": "sub:document",
          "data-color-scheme": "dark",
        }}
        hasOpenChildPopup={() => false}
        onDismiss={() => {}}
      />,
    );
    const panel = document.querySelector("[data-overlay-panel]");
    const sub = panel?.closest('[data-theme-scope="sub:document"]');
    expect(sub).not.toBeNull();
    // The sub-theme's scope sits inside the app's, as it does on the page.
    expect(
      sub?.parentElement?.closest('[data-theme-scope="app:site"]'),
    ).not.toBeNull();
    // The scheme is the app scope's alone: repeated on the sub-theme's box it
    // would re-root the scheme's default palette there.
    expect(sub?.hasAttribute("data-color-scheme")).toBe(false);
  });
});
