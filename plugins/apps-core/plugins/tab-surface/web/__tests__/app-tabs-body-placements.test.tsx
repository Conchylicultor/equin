import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The fallback body (no `Apps.Surface` contributed — the website) is the
// surface, so it registers what it is: docked only, wearing the focused app's
// theme. Without it the placement registry stayed empty forever, and which app
// owns `:root` was never known. Registered on mount, disposed on unmount.

const registry = vi.hoisted(() => ({
  installed: [] as unknown[],
  disposed: 0,
}));

vi.mock("@plugins/apps-core/plugins/tabs/web", () => ({
  useTabs: () => ({ tabs: [], focusedTabId: undefined }),
  registerPlacementCapabilities: (caps: unknown) => {
    registry.installed.push(caps);
    return () => {
      registry.disposed++;
    };
  },
}));

vi.mock("../components/tab-surface", () => ({
  TabSurface: () => null,
}));

import { AppTabsBody } from "../components/app-tabs-body";

afterEach(() => {
  cleanup();
  registry.installed.length = 0;
  registry.disposed = 0;
});

describe("AppTabsBody's placement capabilities", () => {
  it("registers docked only on mount and disposes on unmount", () => {
    const { unmount } = render(<AppTabsBody />);
    expect(registry.installed).toEqual([
      {
        defaultId: "docked",
        ids: new Set(["docked"]),
        newTabFollows: new Set(),
        appThemeScope: new Set(["docked"]),
        ownsChrome: new Set(),
        allowsEmpty: new Set(),
      },
    ]);
    expect(registry.disposed).toBe(0);

    unmount();
    expect(registry.disposed).toBe(1);
  });
});
