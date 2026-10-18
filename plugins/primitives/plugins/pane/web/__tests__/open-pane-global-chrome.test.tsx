import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  createPaneStore,
  Pane,
  setLiveStore,
  usePaneStore,
  useOpenPane,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "../testing";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";

// Opening a pane from GLOBAL CHROME — anything mounted at `Core.Root` or in the
// tab bar, which has no `PaneSurfaceProvider` of its own: the floating action
// bar and every popover hanging off it (Improve), the notification bell.
//
// This used to throw at render, because `useOpenPane` read the reactive
// `usePaneStore()`. The failure was invisible until a reusable control was
// dropped into such a surface — an active-data chip pasted into the Improve
// popover crashed the whole Lexical editor into a nameless "An error was
// thrown." box. Opening a pane is an imperative op, not a route subscription,
// so it now targets the focused tab. The reactive reads still require a
// surface, and the last case here pins that they do.

const testApp = defineApp({
  id: "chrome-app",
  name: "Global chrome test app",
  // Rooted at "/": the surfaces here run at the bare base path, and a route
  // headed by another app's pane would be handed to that app.
  basePath: "/",
  iconKey: "science",
});

const listRoute = defineRoute({ id: "chrome-list", segment: "list" });
const listPane = Pane.define({
  route: listRoute,
  app: testApp,
  component: () => null,
});
const detailRoute = defineRoute({ id: "chrome-detail", segment: "d/:id" });
const detailPane = Pane.define({
  route: detailRoute,
  app: testApp,
  useResolve: false,
  component: () => null,
});

const testPlugin = {
  id: "open-pane-global-chrome-test-plugin",
  description: "global-chrome open-pane fixture",
  contributions: [
    Pane.Register({ pane: listPane }),
    Pane.Register({ pane: detailPane }),
  ],
} as unknown as LoadedPlugin;

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

/** Stands in for a chip rendered in the action bar: no surface above it. */
function GlobalChromeChip({ id }: { id: string }) {
  const openPane = useOpenPane();
  return (
    <button
      type="button"
      onClick={() => openPane(detailPane, { id }, { mode: "push" })}
    >
      open
    </button>
  );
}

beforeAll(() => {
  render(
    <PluginProvider plugins={[testPlugin]}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  setLiveStore(defaultStore);
});

afterEach(() => {
  cleanup();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

describe("useOpenPane outside every pane surface", () => {
  it("renders and navigates the focused tab instead of throwing", () => {
    const focused = createPaneStore({ live: false });
    setLiveStore(focused);

    const { getByRole } = render(<GlobalChromeChip id="7" />);
    getByRole("button").click();

    expect(focused.getRoute().map((s) => s.paneId)).toEqual(["chrome-detail"]);
    expect(focused.getRoute().at(-1)!.params).toEqual({ id: "7" });
  });

  it("targets the tab focused when the CLICK happens, not when it rendered", () => {
    const first = createPaneStore({ live: false });
    const second = createPaneStore({ live: false });
    setLiveStore(first);

    // Global chrome outlives the tab it was rendered beside: the popover stays
    // mounted across a focus switch, so a store sampled during render would
    // navigate a tab the user has already left.
    const { getByRole } = render(<GlobalChromeChip id="9" />);
    setLiveStore(second);
    getByRole("button").click();

    expect(first.getRoute()).toEqual([]);
    expect(second.getRoute().map((s) => s.paneId)).toEqual(["chrome-detail"]);
  });

  it("answers useOpenedHere() with null — the read half of opening — instead of throwing", () => {
    // The shape `useConversationOpener` has: open + "is this the one I opened?".
    // A `conv-<id>` chip in the Improve popover crashed on the read half.
    const focused = createPaneStore({ live: false });
    setLiveStore(focused);
    focused.openPaneImpl(detailPane._internal, { id: "7" }, {});

    function ChromeOpener() {
      const opened = detailPane.useOpenedHere();
      return (
        <>
          <output>{opened === null ? "none" : opened.params.id}</output>
          <GlobalChromeChip id="7" />
        </>
      );
    }
    const { getByRole } = render(<ChromeOpener />);

    // The focused tab DOES hold a detail pane, but this caller has no route and
    // no position, so it opened nothing "here".
    expect(getByRole("status").textContent).toBe("none");
  });

  it("still throws for the REACTIVE route reads, which genuinely need a surface", () => {
    function StoreReader() {
      usePaneStore();
      return null;
    }
    function EntryReader() {
      detailPane.useRouteEntry();
      return null;
    }
    expect(() => render(<StoreReader />)).toThrow(/PaneSurfaceProvider/);
    expect(() => render(<EntryReader />)).toThrow(/PaneSurfaceProvider/);
  });
});
