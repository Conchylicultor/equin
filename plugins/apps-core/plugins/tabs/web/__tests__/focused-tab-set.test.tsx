import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  claimTabSet,
  PAGE_TAB_SET_ID,
  peekFocusedTabSet,
  registerTabSet,
  tabSetModeChanged,
  useFocusedTabSet,
  type TabSetHandle,
} from "../internal/tab-sets";

// Chrome outside every tab set (the action bar's Layout control) and solo's
// Esc act on the set the user is in — an embed's (a demo window taken full
// screen) as much as the page's — never on the page's by default.

function fakeSet(id: string, initial: string) {
  const state = { mode: initial };
  const handle: TabSetHandle = {
    id,
    contained: id !== PAGE_TAB_SET_ID,
    mode: () => state.mode,
    hasTab: () => false,
    focusedTabId: () => undefined,
    openTabs: () => [],
    setMode: vi.fn((next: string) => {
      state.mode = next;
      tabSetModeChanged();
    }),
    exitToPreviousMode: vi.fn(),
    browserTabUrl: (path: string) => path,
  };
  return { state, handle };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  claimTabSet(PAGE_TAB_SET_ID);
});

describe("the tab set the user is in", () => {
  it("follows a claim, and re-renders on that set's mode change", () => {
    const page = fakeSet(PAGE_TAB_SET_ID, "solo");
    const embed = fakeSet("embed:x", "floating");
    disposers.push(registerTabSet(page.handle), registerTabSet(embed.handle));

    const { result } = renderHook(() => useFocusedTabSet());
    expect(result.current.handle).toBe(page.handle);
    expect(result.current.mode).toBe("solo");

    act(() => claimTabSet(embed.handle.id));
    expect(result.current.handle).toBe(embed.handle);
    expect(result.current.mode).toBe("floating");

    act(() => result.current.handle!.setMode("solo"));
    expect(result.current.mode).toBe("solo");
    expect(page.state.mode).toBe("solo");
    expect(page.handle.setMode).not.toHaveBeenCalled();
  });

  it("falls back to the page's set once the claimed one unmounts", () => {
    const page = fakeSet(PAGE_TAB_SET_ID, "docked");
    const embed = fakeSet("embed:y", "solo");
    disposers.push(registerTabSet(page.handle));
    const disposeEmbed = registerTabSet(embed.handle);
    claimTabSet(embed.handle.id);

    const { result } = renderHook(() => useFocusedTabSet());
    expect(result.current.handle).toBe(embed.handle);

    act(() => disposeEmbed());
    expect(result.current.handle).toBe(page.handle);
    expect(result.current.mode).toBe("docked");
  });

  it("hands solo's exit to the claimed set, not the page's", () => {
    const page = fakeSet(PAGE_TAB_SET_ID, "solo");
    const embed = fakeSet("embed:z", "solo");
    disposers.push(registerTabSet(page.handle), registerTabSet(embed.handle));
    claimTabSet(embed.handle.id);

    peekFocusedTabSet()?.exitToPreviousMode();
    expect(embed.handle.exitToPreviousMode).toHaveBeenCalledTimes(1);
    expect(page.handle.exitToPreviousMode).not.toHaveBeenCalled();
  });
});
