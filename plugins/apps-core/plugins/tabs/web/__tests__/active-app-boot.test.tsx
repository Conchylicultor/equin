import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps, setFocusedApp, useActiveApp } from "@plugins/apps-core/web";
import { getFocusedAppId } from "@plugins/apps-core/web/testing";
import { setLiveStore } from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "@plugins/primitives/plugins/pane/web/testing";
import { TabsProvider } from "../internal/use-tabs";

// Chrome that reads the active app (the theme scope, a variant region) must
// settle on its first render: the focused app TabsProvider publishes after
// mount is the app the URL already resolved to, so its publish — and an in-app
// navigation that keeps the app — must not re-render any reader.

const appsPlugin = {
  id: "active-app-boot-test-apps",
  description: "fake apps for the active-app boot suite",
  contributions: [
    Apps.App({
      app: { id: "pages", name: "Pages", basePath: "/pages", iconKey: "home" },
      component: () => null,
      icon: {} as never,
    }),
    Apps.App({
      app: { id: "story", name: "Story", basePath: "/story", iconKey: "home" },
      component: () => null,
      icon: {} as never,
    }),
  ],
} as unknown as LoadedPlugin;

// The deployed composition's home — what a bare `/` and a last-closed tab seed.
const composition = { id: "test", home: "pages" };

const seen: (string | undefined)[] = [];
function Reader() {
  seen.push(useActiveApp()?.id);
  return null;
}

beforeEach(() => {
  seen.length = 0;
  window.history.replaceState(null, "", "/story");
  setFocusedApp(undefined);
});

afterEach(() => {
  cleanup();
  setFocusedApp(undefined);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

describe("useActiveApp at boot", () => {
  it("renders the URL's app once, though the focused app is published after mount", () => {
    render(
      <PluginProvider plugins={[appsPlugin]} composition={composition}>
        <Reader />
        <TabsProvider>
          <Reader />
        </TabsProvider>
      </PluginProvider>,
    );

    expect(getFocusedAppId()).toBe("story");
    expect(seen).toEqual(["story", "story"]);
  });

  it("does not re-render on an in-app navigation that keeps the app", () => {
    render(
      <PluginProvider plugins={[appsPlugin]} composition={composition}>
        <TabsProvider>
          <Reader />
        </TabsProvider>
      </PluginProvider>,
    );
    seen.length = 0;

    act(() => {
      window.history.pushState(null, "", "/story/elsewhere");
      window.dispatchEvent(new CustomEvent("shell:navigate"));
    });
    expect(seen).toEqual([]);

    act(() => setFocusedApp("pages"));
    expect(seen).toEqual(["pages"]);
  });
});
