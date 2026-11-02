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
});
