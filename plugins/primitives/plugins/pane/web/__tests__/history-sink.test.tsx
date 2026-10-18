import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  createPaneStore,
  Pane,
  setHistoryAdapter,
  setLiveStore,
  useSyncPaneRegistry,
  type LocationChange,
} from "@plugins/primitives/plugins/pane/web";
import { defaultStore } from "../testing";
import { defaultHistoryAdapter } from "../history-sink";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";

// Proves the `HistoryAdapter` seam the shell-history-snapshot refactor rests on:
// the pane store never touches `window.history` directly — it emits push/replace
// INTENTS through the installed adapter (`commit`), and the ONE module-level
// `popstate` listener is the single caller of `restore()`. A stub adapter lets us
// read the intents verbatim; the `defaultHistoryAdapter` proves standalone
// behavior is unchanged when no shell adapter is installed.
//
// Mirrors `pane-isolation.test.tsx`: a self-contained set of test panes is
// registered into the module-global registry via a minimal PluginProvider +
// `useSyncPaneRegistry`, so `buildRouteUrl` / route mutation have real panes to
// resolve — no full plugin graph, so the suite stays boundary-clean.

// Local fixture app — this suite is about history intents, not pane homes.
const testApp = defineApp({
  id: "hist-app",
  name: "History test app",
  // Rooted at "/": the stores here run at the bare base path, and a route
  // headed by another app's pane would be handed to that app.
  basePath: "/",
  iconKey: "science",
});

const rootRoute = defineRoute({ id: "hist-root", segment: "hist" });
const rootPane = Pane.define({
  route: rootRoute,
  app: testApp,
  component: () => null,
});
const childRoute = defineRoute({ id: "hist-child", segment: "c/:id" });
const childPane = Pane.define({
  route: childRoute,
  app: testApp,
  useResolve: false,
  component: () => null,
});
// A pane that opts OUT of history (`chrome.history: false`) — its open/close
// mutations REPLACE instead of push, so we can prove the mode is threaded both
// ways through the adapter, not hard-coded.
const noHistoryRoute = defineRoute({ id: "hist-nohistory", segment: "nh" });
const noHistoryPane = Pane.define({
  route: noHistoryRoute,
  app: testApp,
  component: () => null,
  chrome: { history: false },
});

const testPlugin = {
  id: "history-sink-test-plugin",
  description: "history-sink test fixture",
  contributions: [
    Pane.Register({ pane: rootPane }),
    Pane.Register({ pane: childPane }),
    Pane.Register({ pane: noHistoryPane }),
  ],
} as unknown as LoadedPlugin;

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

beforeAll(() => {
  // Populate the module-global pane registry so `buildRouteUrl` resolves the
  // test panes. Persists after unmount (registry is module-global).
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
  // Always restore the default adapter + default live store so a suite never
  // leaks a stub adapter onto the next test (or another suite in this file).
  setHistoryAdapter(defaultHistoryAdapter);
  setLiveStore(defaultStore);
  window.history.replaceState(null, "", "/");
});

describe("route listeners see the committed URL", () => {
  // The tab set persists the address bar as a route's rawPath from a route
  // listener; a reload gives panes back their instance ids only when that
  // rawPath is the reloaded URL. So a listener must never see the new route
  // beside the previous URL.
  it("the address bar has moved when a listener hears of an open", () => {
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");
    store.restoreRoute([{ paneId: "hist-root", params: {} }]);
    const seen: string[] = [];
    const unsub = store.subscribeRoute(() => {
      seen.push(window.location.pathname);
    });

    store.openPaneImpl(childPane._internal, { id: "7" });
    store.navigatePending("nowhere/yet");
    unsub();

    expect(seen).toEqual(["/c/7", "/nowhere/yet"]);
  });
});

describe("commit intents — mode + url + state per the push/replace matrix", () => {
  it("pane open emits a PUSH intent with the correct url and state.route", () => {
    const commit = vi.fn();
    setHistoryAdapter({ commit, restore: vi.fn() });
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");

    store.openPaneImpl(rootPane._internal, {}, { root: true });

    expect(commit).toHaveBeenCalledTimes(1);
    const change = commit.mock.calls[0]![0] as LocationChange;
    expect(change.mode).toBe("push");
    expect(change.url).toBe("/hist");
    expect(change.state).toEqual({
      route: [expect.objectContaining({ paneId: "hist-root", params: {} })],
    });
  });

  it("pane close emits a PUSH intent (chrome.history default) truncating the route", () => {
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");
    store.restoreRoute([
      { paneId: "hist-root", params: {} },
      { paneId: "hist-child", params: { id: "1" } },
    ]);
    const child = store.getRoute()[1]!;

    // Install the recorder AFTER the setup navigation so only the close is seen.
    const commit = vi.fn();
    setHistoryAdapter({ commit, restore: vi.fn() });

    store.close(childPane._internal, child.instanceId);

    expect(commit).toHaveBeenCalledTimes(1);
    const change = commit.mock.calls[0]![0] as LocationChange;
    expect(change.mode).toBe("push");
    expect(change.url).toBe("/hist");
    expect(change.state).toEqual({
      route: [expect.objectContaining({ paneId: "hist-root" })],
    });
  });

  it("pane promote emits a PUSH intent rooted at the promoted pane", () => {
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");
    store.restoreRoute([
      { paneId: "hist-root", params: {} },
      { paneId: "hist-child", params: { id: "1" } },
    ]);
    const child = store.getRoute()[1]!;

    const commit = vi.fn();
    setHistoryAdapter({ commit, restore: vi.fn() });

    store.promote(childPane._internal, child.instanceId);

    expect(commit).toHaveBeenCalledTimes(1);
    const change = commit.mock.calls[0]![0] as LocationChange;
    expect(change.mode).toBe("push");
    expect(change.url).toBe("/c/1");
    expect(change.state).toEqual({
      route: [
        expect.objectContaining({ paneId: "hist-child", params: { id: "1" } }),
      ],
    });
  });

  it("a no-history pane open emits a REPLACE intent (mode threaded both ways)", () => {
    const commit = vi.fn();
    setHistoryAdapter({ commit, restore: vi.fn() });
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");

    store.openPaneImpl(noHistoryPane._internal, {}, { root: true });

    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]![0] as LocationChange).mode).toBe("replace");
  });

  it("navigatePending emits a PUSH intent carrying { pending }", () => {
    const commit = vi.fn();
    setHistoryAdapter({ commit, restore: vi.fn() });
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");

    store.navigatePending("later/42");

    expect(commit).toHaveBeenCalledTimes(1);
    const change = commit.mock.calls[0]![0] as LocationChange;
    expect(change.mode).toBe("push");
    expect(change.state).toEqual({ pending: "later/42" });
  });
});

describe("event contract — popstate restores, programmatic navigation does not", () => {
  it("a real popstate calls exactly adapter.restore(); a shell:navigate does not", () => {
    const restore = vi.fn();
    // Mirror the real commit's side-effect: announce `shell:navigate` (NOT a
    // synthetic popstate). This is the exact contract — programmatic navigation
    // must never reach the popstate listener that drives restore().
    const commit = vi.fn(() => {
      window.dispatchEvent(new CustomEvent("shell:navigate"));
    });
    setHistoryAdapter({ commit, restore });
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");

    store.setRoute([]); // programmatic navigation → commit → shell:navigate
    expect(commit).toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();

    window.dispatchEvent(new PopStateEvent("popstate")); // real browser back/forward
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("defaultHistoryAdapter — standalone behavior with no shell adapter", () => {
  it("writes { route } verbatim into history.state, and restore drives handleLocationChange", () => {
    setHistoryAdapter(defaultHistoryAdapter);
    const store = createPaneStore({ live: true });
    setLiveStore(store);
    store.setBasePath("");

    store.restoreRoute([{ paneId: "hist-root", params: {} }]);

    // commit wrote the route payload verbatim (no { tabId, appId } — no shell).
    expect(window.history.state).toMatchObject({
      route: [{ paneId: "hist-root" }],
    });
    expect(window.history.state).not.toHaveProperty("tabId");
    expect(store.getRoute().map((s) => s.paneId)).toEqual(["hist-root"]);

    // Simulate a browser back/forward onto a different entry: the browser has
    // already updated history.state + URL; the popstate listener → restore() →
    // getLiveStore().handleLocationChange() rebuilds the live store from it.
    window.history.pushState(
      {
        route: [
          {
            paneId: "hist-child",
            params: { id: "9" },
            options: {},
            uuid: "u9",
          },
        ],
      },
      "",
      "/c/9",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(store.getRoute().map((s) => s.paneId)).toEqual(["hist-child"]);
    expect(store.getRoute()[0]!.params.id).toBe("9");
  });
});
