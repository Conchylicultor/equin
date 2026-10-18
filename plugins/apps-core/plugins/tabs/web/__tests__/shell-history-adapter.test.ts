import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveApp } from "@plugins/apps-core/web";
import { getAppInstanceId } from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import type { RouteState } from "@plugins/primitives/plugins/pane/web";
import {
  makeShellHistoryAdapter,
  serializePaneState,
  type ShellHistoryDeps,
} from "../internal/shell-history-adapter";
import type { Tab } from "../internal/tabs-store";

// Unit-tests the shell history adapter as the pure factory it is: `commit`
// stamps the FOCUSED tab's { tabId, appId } onto every entry, and `restore`
// reads a snapshot back out of `window.history.state` and dispatches to the
// right history-free dep callback per the 8-step matrix — with ZERO history
// writes (restoration must never re-enter the commit path). The dep callbacks
// are spies here; the TabsProvider integration suite proves they flip the real
// tab liveness/focus. This suite pins the decision logic itself.

/**
 * Two fake registered tab apps; `resolveAppForPath` reads only the
 * contribution's `.id`, its `AppRef`'s `.basePath` (the app is handed to
 * `Apps.App` whole, so the base path lives on `.app`, not on the contribution)
 * and its `component` (only a tab app owns a URL).
 */
const APPS = [
  {
    id: "pages",
    app: { id: "pages", name: "Pages", basePath: "/pages" },
    component: () => null,
  },
  {
    id: "story",
    app: { id: "story", name: "Story", basePath: "/story" },
    component: () => null,
  },
] as unknown as ActiveApp[];

/** A fake open tab; the adapter reads only `.tabId` / `.appId` (never `.store`). */
function tab(tabId: string, appId: string): Tab {
  return { tabId, appId } as unknown as Tab;
}

function makeDeps(opts: {
  focused: { tabId: string; appId: string } | null;
  tabs?: Tab[];
}) {
  const refocus = vi.fn();
  const rebuildAppInPlace = vi.fn();
  const restoreLiveRoute = vi.fn();
  const setFocusedApp = vi.fn();
  const persist = vi.fn();
  const deps: ShellHistoryDeps = {
    focused: () => opts.focused,
    tabs: () => opts.tabs ?? [],
    apps: () => APPS,
    refocus,
    rebuildAppInPlace,
    restoreLiveRoute,
    setFocusedApp,
    persist,
  };
  return {
    deps,
    refocus,
    rebuildAppInPlace,
    restoreLiveRoute,
    setFocusedApp,
    persist,
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("serializePaneState", () => {
  it("serializes a resolved route to { route } dropping instanceId + hint", () => {
    const state: RouteState = {
      kind: "resolved",
      slots: [
        {
          instanceId: 7,
          uuid: "u1",
          paneId: "p",
          params: { id: "1" },
          options: { compact: true },
          hint: { title: "ephemeral" },
        },
      ],
    };
    expect(serializePaneState(state)).toEqual({
      route: [
        {
          paneId: "p",
          params: { id: "1" },
          options: { compact: true },
          uuid: "u1",
        },
      ],
    });
  });

  it("serializes an unresolved route to { pending }", () => {
    const state: RouteState = { kind: "unresolved", rawPath: "later/42" };
    expect(serializePaneState(state)).toEqual({ pending: "later/42" });
  });
});

describe("commit — stamps the focused tab's identity onto every entry", () => {
  it("merges { tabId, appId, appInstance } into the route payload and PUSHES on mode push", () => {
    const { deps } = makeDeps({ focused: { tabId: "T1", appId: "pages" } });
    const adapter = makeShellHistoryAdapter(deps);
    const pushSpy = vi.spyOn(window.history, "pushState");

    adapter.commit({
      url: "/pages/x",
      state: {
        route: [{ paneId: "p", params: { id: "x" }, options: {}, uuid: "u" }],
      },
      mode: "push",
    });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/pages/x");
    expect(window.history.state).toEqual({
      route: [{ paneId: "p", params: { id: "x" }, options: {}, uuid: "u" }],
      tabId: "T1",
      appId: "pages",
      // Which running app-state those ids are meaningful in — the *which* half
      // of a later cold boot's fresh-vs-preserve decision.
      appInstance: getAppInstanceId(),
    });
  });

  it("REPLACES on mode replace", () => {
    const { deps } = makeDeps({ focused: { tabId: "T1", appId: "pages" } });
    const adapter = makeShellHistoryAdapter(deps);
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    adapter.commit({ url: "/pages", state: { route: [] }, mode: "replace" });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({
      tabId: "T1",
      appId: "pages",
      appInstance: getAppInstanceId(),
    });
  });

  it("writes the payload verbatim (no stamp) when no tab is focused yet", () => {
    const { deps } = makeDeps({ focused: null });
    const adapter = makeShellHistoryAdapter(deps);

    adapter.commit({ url: "/pages", state: { pending: "p/1" }, mode: "push" });

    // Verbatim: an entry with no tab identity carries no instance either —
    // half a snapshot is worse than none, and `restore()` reads it as legacy.
    expect(window.history.state).toEqual({ pending: "p/1" });
    expect(window.history.state).not.toHaveProperty("tabId");
    expect(window.history.state).not.toHaveProperty("appInstance");
  });
});

describe("restore — snapshot → the right history-free dep, never a history write", () => {
  it("returns early when nothing is focused (popstate before the provider mounted)", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({ focused: null });
    window.history.replaceState(
      { tabId: "T1", appId: "pages", route: [] },
      "",
      "/pages",
    );

    makeShellHistoryAdapter(deps).restore();

    expect(refocus).not.toHaveBeenCalled();
    expect(rebuildAppInPlace).not.toHaveBeenCalled();
    expect(restoreLiveRoute).not.toHaveBeenCalled();
    expect(setFocusedApp).not.toHaveBeenCalled();
  });

  it("legacy/{} entry: reconciles the focused tab to the URL's app (in place, no mint)", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages")],
    });
    // No snapshot was stamped ({}), URL points at story ⇒ URL reparse.
    window.history.replaceState({}, "", "/story/s/1");

    makeShellHistoryAdapter(deps).restore();

    expect(rebuildAppInPlace).toHaveBeenCalledWith("T1", "story");
    expect(refocus).not.toHaveBeenCalled();
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("story");
  });

  it("legacy entry whose URL app already matches the focus does NOT rebuild", () => {
    const { deps, rebuildAppInPlace, restoreLiveRoute, setFocusedApp } =
      makeDeps({
        focused: { tabId: "T1", appId: "pages" },
        tabs: [tab("T1", "pages")],
      });
    window.history.replaceState({ route: [] }, "", "/pages");

    makeShellHistoryAdapter(deps).restore();

    expect(rebuildAppInPlace).not.toHaveBeenCalled();
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("pages");
  });

  it("closed/unknown tabId: applies { appId } to the FOCUSED tab, mints nothing", () => {
    const { deps, refocus, rebuildAppInPlace, setFocusedApp } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages")], // the snapshot's "ghost" tab is gone
    });
    window.history.replaceState(
      { tabId: "ghost", appId: "story", route: [] },
      "",
      "/story",
    );

    makeShellHistoryAdapter(deps).restore();

    // Applied to the focused tab (T1), never the dead ghost id — and no refocus.
    expect(rebuildAppInPlace).toHaveBeenCalledWith("T1", "story");
    expect(refocus).not.toHaveBeenCalled();
    expect(setFocusedApp).toHaveBeenCalledWith("story");
  });

  it("foreign tabId, same app: refocuses that tab (no store rebuild)", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages"), tab("T2", "pages")],
    });
    window.history.replaceState(
      { tabId: "T2", appId: "pages", route: [] },
      "",
      "/pages",
    );

    makeShellHistoryAdapter(deps).restore();

    expect(refocus).toHaveBeenCalledWith("T2");
    expect(rebuildAppInPlace).not.toHaveBeenCalled();
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("pages");
  });

  it("matching tabId, different app: rebuilds that tab in place with NO history write", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages"), tab("T2", "pages")],
    });
    window.history.replaceState(
      { tabId: "T2", appId: "story", route: [] },
      "",
      "/story",
    );
    // Spy AFTER the setup write so the assertion sees only what restore() does.
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    makeShellHistoryAdapter(deps).restore();

    expect(rebuildAppInPlace).toHaveBeenCalledWith("T2", "story");
    expect(refocus).not.toHaveBeenCalled();
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("story");
    // Restoration NEVER writes history — the browser already advanced it.
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("FOREIGN appInstance: falls back to URL reparse, never refocuses the foreign tabId", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      // T2 exists here, so only the instance check can stop the adapter from
      // trusting the entry — if it refocused T2 it would be honouring a tabId
      // minted by a different running app-state that happens to collide.
      tabs: [tab("T1", "pages"), tab("T2", "pages")],
    });
    window.history.replaceState(
      {
        tabId: "T2",
        appId: "pages",
        appInstance: "some-other-instance",
        route: [],
      },
      "",
      "/story/s/1",
    );

    makeShellHistoryAdapter(deps).restore();

    expect(refocus).not.toHaveBeenCalled();
    // The URL is the only part of a foreign entry this instance can trust.
    expect(rebuildAppInPlace).toHaveBeenCalledWith("T1", "story");
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("story");
  });

  it("OWN appInstance: the snapshot is trusted (the guard is instance-scoped, not blanket)", () => {
    const { deps, refocus, rebuildAppInPlace, setFocusedApp } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages"), tab("T2", "pages")],
    });
    window.history.replaceState(
      {
        tabId: "T2",
        appId: "pages",
        appInstance: getAppInstanceId(),
        route: [],
      },
      "",
      "/pages",
    );

    makeShellHistoryAdapter(deps).restore();

    expect(refocus).toHaveBeenCalledWith("T2");
    expect(rebuildAppInPlace).not.toHaveBeenCalled();
    expect(setFocusedApp).toHaveBeenCalledWith("pages");
  });

  it("matching tabId, already focused, same app: only restores the route", () => {
    const {
      deps,
      refocus,
      rebuildAppInPlace,
      restoreLiveRoute,
      setFocusedApp,
    } = makeDeps({
      focused: { tabId: "T1", appId: "pages" },
      tabs: [tab("T1", "pages")],
    });
    window.history.replaceState(
      { tabId: "T1", appId: "pages", route: [] },
      "",
      "/pages",
    );

    makeShellHistoryAdapter(deps).restore();

    expect(refocus).not.toHaveBeenCalled();
    expect(rebuildAppInPlace).not.toHaveBeenCalled();
    expect(restoreLiveRoute).toHaveBeenCalledTimes(1);
    expect(setFocusedApp).toHaveBeenCalledWith("pages");
  });
});
