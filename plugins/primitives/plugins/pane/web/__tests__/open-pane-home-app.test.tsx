import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  AppNavBoundary,
  appNavSink,
  openPane as openPaneImperative,
  Pane,
  PaneInstanceContext,
  routeHomeApp,
  setLiveStore,
  useOpenPane,
  useSyncPaneRegistry,
  type OpenPaneFn,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkGestureProps } from "@plugins/primitives/plugins/link-gesture/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface, defaultStore } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// A ROUTE BELONGS TO ITS ROOT PANE'S APP.
//
// Another app's pane may be hosted here as a GUEST, beside one of this app's
// panes. It may never head this app's route: that is the other app's surface
// stranded in this one (a Settings setup pane opened from Places painted full
// screen, with no Settings around it). So an open whose route would be headed
// by another app's pane goes to that app instead — the same route, rooted at
// its home — through the cross-app navigator, exactly as Expand does.

const hostApp = defineApp({
  id: "home-host",
  name: "Host",
  basePath: "/host",
  icon: symbol("science"),
});
const guestApp = defineApp({
  id: "home-guest",
  name: "Guest",
  basePath: "/guest",
  icon: symbol("science"),
});

const hostPane = Pane.define({
  route: defineRoute({ id: "home-host-list", segment: "list" }),
  app: hostApp,
  component: () => null,
});
const guestParentRoute = defineRoute({ id: "home-guest-acc", segment: "acc" });
const guestParent = Pane.define({
  route: guestParentRoute,
  app: guestApp,
  component: () => null,
});
const guestPane = Pane.define({
  route: defineRoute({
    id: "home-guest-setup",
    segment: "setup/:step",
    parent: guestParentRoute,
  }),
  app: guestApp,
  useResolve: false,
  component: () => null,
});

// A guest that accompanies what is on screen: at the route's head it sits
// beside the host's index pane, so it names no app of its own.
const guestCompanion = Pane.define({
  route: defineRoute({ id: "home-guest-companion", segment: "peek/:id" }),
  app: guestApp,
  useResolve: false,
  companion: true,
  component: () => null,
});

// A host pane whose from-scratch parent is the guest's: its Back, at the
// route's root, opens a route headed by another app's pane.
const hostUnderGuest = Pane.define({
  route: defineRoute({
    id: "home-host-under-guest",
    segment: "under",
    parent: guestParentRoute,
  }),
  app: hostApp,
  component: () => null,
});

const plugins = [
  {
    id: "open-pane-home-app-test-plugin",
    description: "open-pane home-app fixture",
    contributions: [
      Pane.Register({ pane: hostPane }),
      Pane.Register({ pane: guestParent }),
      Pane.Register({ pane: guestPane }),
      Pane.Register({ pane: hostUnderGuest }),
      Pane.Register({ pane: guestCompanion }),
    ],
  } as unknown as LoadedPlugin,
];

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

function OpenButton({
  props,
}: {
  props: (open: OpenPaneFn) => LinkGestureProps;
}) {
  const openPane = useOpenPane();
  return (
    <button type="button" {...props(openPane)}>
      open
    </button>
  );
}

let store: PaneStore;
let navigated: string[];
let uninstall: (() => void) | null;

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
  store.setBasePath("/host");
  store.restoreRoute([{ paneId: "home-host-list", params: {} }]);
  navigated = [];
  uninstall = appNavSink.install((url) => {
    navigated.push(url);
  });
});

afterEach(() => {
  cleanup();
  uninstall?.();
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

const shape = () => store.getRoute().map((s) => s.paneId);

function mount(
  props: (open: OpenPaneFn) => LinkGestureProps,
  opts: { caller?: boolean; boundary?: (url: string) => void } = {},
): HTMLElement {
  const callerInstanceId = opts.caller
    ? store.getRoute()[0]!.instanceId
    : undefined;
  const button = (
    <PaneInstanceContext.Provider value={callerInstanceId}>
      <OpenButton props={props} />
    </PaneInstanceContext.Provider>
  );
  const view = render(
    <TestSurface store={store} plugins={plugins} basePath="/host">
      {opts.boundary ? (
        <AppNavBoundary navigator={opts.boundary}>{button}</AppNavBoundary>
      ) : (
        button
      )}
    </TestSurface>,
  );
  return view.getByRole("button");
}

describe("routeHomeApp", () => {
  it("is the root pane's app, whoever is hosted after it", () => {
    store.restoreRoute([
      { paneId: "home-host-list", params: {} },
      { paneId: "home-guest-setup", params: { step: "1" } },
    ]);
    expect(routeHomeApp(store.getRoute())?.id).toBe("home-host");
  });

  it("names no app for the empty route", () => {
    expect(routeHomeApp([])).toBeUndefined();
  });

  it("names no app for a route headed by a companion", () => {
    store.restoreRoute([
      { paneId: "home-guest-companion", params: { id: "a" } },
    ]);
    expect(routeHomeApp(store.getRoute())).toBeUndefined();
  });
});

describe("useOpenPane: a companion opened at the bare root stays here", () => {
  it("an append from the empty route keeps the companion in this app", () => {
    store.clearRoute();
    const button = mount((open) =>
      open.link(guestCompanion, { id: "a" }, { mode: "append" }),
    );
    fireEvent.click(button);
    expect(navigated).toEqual([]);
    expect(shape()).toEqual(["home-guest-companion"]);
    expect(window.location.pathname).toBe("/host/peek/a");
  });
});

describe("useOpenPane: a route headed by another app's pane goes to that app", () => {
  it("a root open hands the route, rooted at its home, to the navigator", () => {
    const button = mount((open) =>
      open.link(guestPane, { step: "2" }, { mode: "root" }),
    );
    fireEvent.click(button);
    expect(navigated).toEqual(["/guest/acc/setup/2"]);
    expect(shape()).toEqual(["home-host-list"]);
  });

  it("the link's href is that same home-app URL", () => {
    let href = "";
    mount((open) => {
      href = open.to(guestPane, { step: "2" }, { mode: "root" }).href();
      return {} as LinkGestureProps;
    });
    expect(href).toBe("/guest/acc/setup/2");
  });

  it("a no-caller push that would root the guest hands off too", () => {
    store.clearRoute();
    const button = mount((open) =>
      open.link(guestPane, { step: "3" }, { mode: "push" }),
    );
    fireEvent.click(button);
    expect(navigated).toEqual(["/guest/acc/setup/3"]);
  });

  it("an embed's boundary answers before the installed navigator", () => {
    const bounded: string[] = [];
    const button = mount(
      (open) => open.link(guestPane, { step: "4" }, { mode: "root" }),
      { boundary: (url) => bounded.push(url) },
    );
    fireEvent.click(button);
    expect(bounded).toEqual(["/guest/acc/setup/4"]);
    expect(navigated).toEqual([]);
  });

  it("with no navigator it throws rather than strand the route here", () => {
    uninstall?.();
    uninstall = null;
    let captured: OpenPaneFn | null = null;
    mount((open) => {
      captured = open;
      return {} as LinkGestureProps;
    });
    expect(() =>
      captured!(guestPane, { step: "5" }, { mode: "root" }),
    ).toThrow();
    expect(shape()).toEqual(["home-host-list"]);
  });
});

describe("useOpenPane: a guest beside a host pane stays here", () => {
  it("a push from the host pane hosts the guest after it", () => {
    const button = mount(
      (open) => open.link(guestPane, { step: "1" }, { mode: "push" }),
      { caller: true },
    );
    fireEvent.click(button);
    expect(navigated).toEqual([]);
    expect(shape()).toEqual(["home-host-list", "home-guest-setup"]);
    expect(window.location.pathname).toBe("/host/list/setup/1");
  });

  it("a root open of this app's own pane stays here", () => {
    const button = mount((open) => open.link(hostPane, {}, { mode: "root" }));
    store.restoreRoute([
      { paneId: "home-host-list", params: {} },
      { paneId: "home-guest-setup", params: { step: "1" } },
    ]);
    fireEvent.click(button);
    expect(navigated).toEqual([]);
    expect(shape()).toEqual(["home-host-list"]);
  });
});

describe("openPane (imperative): the same rule", () => {
  it("a root open of another app's pane navigates to its home", () => {
    openPaneImperative(guestPane, { step: "6" }, { mode: "root" });
    expect(navigated).toEqual(["/guest/acc/setup/6"]);
    expect(shape()).toEqual(["home-host-list"]);
  });
});

describe("useBack: a parent of another app goes through the boundary", () => {
  function BackButton() {
    const back = hostUnderGuest.useBack();
    return (
      <button type="button" disabled={back === null} onClick={() => back?.()}>
        back
      </button>
    );
  }

  function mountBack(boundary?: (url: string) => void): HTMLElement {
    store.restoreRoute([{ paneId: "home-host-under-guest", params: {} }]);
    const button = (
      <PaneInstanceContext.Provider value={store.getRoute()[0]!.instanceId}>
        <BackButton />
      </PaneInstanceContext.Provider>
    );
    const view = render(
      <TestSurface store={store} plugins={plugins} basePath="/host">
        {boundary ? (
          <AppNavBoundary navigator={boundary}>{button}</AppNavBoundary>
        ) : (
          button
        )}
      </TestSurface>,
    );
    return view.getByRole("button");
  }

  it("inside a boundary, the stranded route is the boundary's, never the installed navigator's", () => {
    const bounded: string[] = [];
    fireEvent.click(mountBack((url) => bounded.push(url)));
    expect(bounded).toEqual(["/guest/acc"]);
    expect(navigated).toEqual([]);
    expect(shape()).toEqual(["home-host-under-guest"]);
  });

  it("outside any boundary, it goes to the installed navigator", () => {
    fireEvent.click(mountBack());
    expect(navigated).toEqual(["/guest/acc"]);
    expect(shape()).toEqual(["home-host-under-guest"]);
  });
});
