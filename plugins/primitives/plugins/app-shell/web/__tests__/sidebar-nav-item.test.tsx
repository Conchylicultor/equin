import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  setLiveStore,
  useSyncPaneRegistry,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import {
  createTestSurfaceStore,
  defaultStore,
  TestSurface,
} from "@plugins/primitives/plugins/pane/web/testing";
import { SidebarProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { opensPane } from "../components/app-shell-layout";
import { SidebarItem } from "../components/sidebar-nav-item";
import { symbol } from "@plugins/ui/plugins/icons/core";

const homeIcon = symbol("home");

// A nav entry that OPENS a pane is data, so the shell can answer "is this the
// current one?" — active exactly while the route's root pane is its pane. An
// `onClick` entry cannot say where it goes, so it is never marked.

const app = defineApp({
  id: "sidebar-nav-test-app",
  name: "Sidebar nav test app",
  basePath: "/nav",
  icon: symbol("science"),
});
const homePane = Pane.define({
  route: defineRoute({ id: "nav-home", segment: "home" }),
  app,
  component: () => null,
});
const otherPane = Pane.define({
  route: defineRoute({ id: "nav-other", segment: "other" }),
  app,
  component: () => null,
});

const plugins = [
  {
    id: "sidebar-nav-test-plugin",
    description: "sidebar nav fixture",
    contributions: [
      Pane.Register({ pane: homePane }),
      Pane.Register({ pane: otherPane }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

let store: PaneStore;

beforeAll(() => {
  render(
    <PluginProvider plugins={plugins}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  store = createTestSurfaceStore();
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

function renderNav() {
  return render(
    <TestSurface store={store} plugins={plugins} basePath="/nav">
      <SidebarProvider>
        <SidebarItem
          title="Home"
          icon={homeIcon}
          opens={opensPane(homePane, {})}
        />
        <SidebarItem title="Other" icon={homeIcon} onClick={() => {}} />
      </SidebarProvider>
    </TestSurface>,
  );
}

const isActive = (name: string) =>
  screen.getByRole("button", { name }).hasAttribute("data-active");

describe("SidebarItem — the opens arm", () => {
  it("is inactive while its pane is not the route root", () => {
    renderNav();
    expect(isActive("Home")).toBe(false);
  });

  it("opens its pane as the root, and is then active", () => {
    renderNav();
    act(() => {
      screen.getByRole("button", { name: "Home" }).click();
    });
    expect(isActive("Home")).toBe(true);
    // An onClick entry is never marked, whatever the route.
    expect(isActive("Other")).toBe(false);
  });
});
