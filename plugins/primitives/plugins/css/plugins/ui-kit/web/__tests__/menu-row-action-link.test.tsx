import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

/**
 * A menu action that navigates is a link: handed over as `activation`, its
 * button gets the browser's link gestures — a plain click opens here, a
 * middle-click opens the destination in a new browser tab (the "Configure"
 * gear of a launch-option pill, whose middle-click used to do nothing).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function target() {
  const open = vi.fn();
  const link: LinkTarget = { open, href: () => "/settings/config/x" };
  return { open, link };
}

function renderMenu(link: LinkTarget) {
  const utils = render(
    <DropdownMenu>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSection
          label="Section"
          action={{
            icon: symbol("settings"),
            label: "Configure",
            activation: link,
          }}
        >
          <DropdownMenuItem>item</DropdownMenuItem>
        </DropdownMenuSection>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  act(() => utils.getByRole("button", { name: "menu" }).click());
  return utils;
}

describe("menu section action as a link", () => {
  it("middle-click opens the destination in a new browser tab", () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const { open, link } = target();
    const { getByLabelText } = renderMenu(link);

    fireEvent(
      getByLabelText("Configure"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(windowOpen).toHaveBeenCalledTimes(1);
    expect(String(windowOpen.mock.calls[0]![0])).toContain(
      "/settings/config/x",
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("plain click opens it here", () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const { open, link } = target();
    const { getByLabelText } = renderMenu(link);

    act(() => getByLabelText("Configure").click());

    expect(open).toHaveBeenCalledTimes(1);
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
