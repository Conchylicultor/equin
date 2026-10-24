import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PluginProvider,
  markDeferredLoadComplete,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  createPaneStore,
  Pane,
  type PaneStore,
  useSyncPaneRegistry,
} from "@plugins/primitives/plugins/pane/web";
import { usePaneRoute } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { createTestSurfaceStore, TestSurface } from "../testing";
import { symbol } from "@plugins/ui/plugins/icons/core";

// A fixture app for the panes below. `Pane.define({ app })` is mandatory, but
// this suite is about URL resolution, not homes — so the app is local to the
// test rather than a real one (importing an app shell here would invert the
// primitive → app dependency).
const testApp = defineApp({
  id: "deep-link-test-app",
  name: "Deep link test app",
  basePath: "/app",
  icon: symbol("science"),
});

// Regression: a cold deep-link reload must not flash the app's index/landing
// pane at the deep-link URL.
//
// `parseUrl` scans the pane registry to match URL segments, so a deep link whose
// target pane isn't registered yet parses as `unresolved` (distinct from the bare
// app root, which parses as `matched []`). With the tri-state route store,
// `usePaneRoute` renders the index pane ONLY for a resolved-empty route (genuine
// bare root); an `unresolved` URL returns null so the layout shows its tri-state
// DeferredRouteFallback (a spinner while the deferred tier loads, then a
// NotFound / app-load-error surface once settled) — never the homepage at the
// deep-link URL, whether loading or settled.

// The app's index/landing pane: `appIndex` makes it what `testApp`'s bare root
// (`/app`) resolves to. It is the ONLY pane we register — the deep link
// intentionally matches nothing, reproducing the "target pane not yet loaded" gap.
const indexRoute = defineRoute({ id: "deep-link-test-index", segment: "" });
const indexPane = Pane.define({
  route: indexRoute,
  app: testApp,
  appIndex: true,
  component: () => null,
});

const testPlugin = {
  id: "deep-link-test-plugin",
  description: "deep-link load-gap test fixture",
  contributions: [Pane.Register({ pane: indexPane })],
} as unknown as LoadedPlugin;

// A deep-link target pane. Registering it turns `/app/thing/:id` from an
// `unresolved` (its plugin "not loaded yet") parse into a `matched` route,
// modeling the deferred plugin arriving.
const targetRoute = defineRoute({
  id: "deep-link-test-target",
  segment: "thing/:id",
});
const targetPane = Pane.define({
  route: targetRoute,
  app: testApp,
  useResolve: false,
  component: () => null,
});

const targetPlugin = {
  id: "deep-link-test-target-plugin",
  description: "deep-link target pane fixture",
  contributions: [
    Pane.Register({ pane: indexPane }),
    Pane.Register({ pane: targetPane }),
  ],
} as unknown as LoadedPlugin;

/** Probes what `usePaneRoute` resolves to: a pane id chain, or "null". */
function Probe({ basePath }: { basePath: string }) {
  const match = usePaneRoute(basePath);
  const label =
    match === null ? "null" : match.panes.map((p) => p.pane.id).join(",");
  return <div data-testid="out">{label}</div>;
}

const realLocation = window.location;
const realHistory = window.history;

/**
 * Stub `window.history.state` (paired with `setPath`) without touching the real
 * history API: raw `pushState` is banned (apps-core/no-raw-history-nav) and the
 * store only ever READS `.state` in `handleLocationChange`, so a plain value
 * stub is the right seam for simulating a back/forward landing.
 */
function setHistoryState(state: unknown): void {
  Object.defineProperty(window, "history", {
    configurable: true,
    writable: true,
    value: { state },
  });
}

/**
 * Point `window.location.pathname` at a cold-load URL. Both `usePathname()` and
 * the live store's `handleLocationChange` read only `.pathname`, and default
 * `history.state` is null, so the store re-derives its route from the URL (as a
 * cold load does) rather than restoring a serialized route. A location stub (not
 * a `history.pushState`/`navigate` call) is the right unit-test seam here: there
 * is no tab/appId to keep in sync, which is all `navigate()` would add.
 */
function setPath(pathname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname },
  });
}

function resolveAt(pathname: string): string {
  setPath(pathname);
  const { getByTestId } = render(
    <TestSurface store={store} plugins={[testPlugin]}>
      <Probe basePath="/app" />
    </TestSurface>,
  );
  return getByTestId("out").textContent ?? "";
}

beforeAll(() => {
  // Populate the module-global pane registry with the index pane so both
  // `parseUrl` (for the empty-route path) and `useIndexMatch` can see it.
  render(
    <PluginProvider plugins={[testPlugin]}>
      <RegistrySync />
    </PluginProvider>,
  );
  cleanup();
});

function RegistrySync() {
  useSyncPaneRegistry();
  return null;
}

// A fresh live surface store per case: the route lives in the store, so a
// shared one would carry the previous case's resolved route into the next.
let store: PaneStore;

beforeEach(() => {
  store = createTestSurfaceStore();
  // The deferred-load signal is a module-global singleton shared across cases in
  // this file — reset it so completion/failure set by one test never leaks into
  // the next (each case starts un-settled, matching a cold boot).
  resetDeferredLoadStateForTests();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  Object.defineProperty(window, "history", {
    configurable: true,
    writable: true,
    value: realHistory,
  });
});

describe("deep-link load gap", () => {
  // The deferred tier starts un-settled (module default), so these two run
  // before we mark it complete below.
  it("suppresses the index fallback for a deep-link URL while the deferred tier is loading", () => {
    // `/app/thing/123` matches no registered pane → `unresolved`. The deep-link
    // path must NOT fall back to the index pane — it resolves to null so the
    // layout renders DeferredRouteFallback (a spinner while loading).
    expect(resolveAt("/app/thing/123")).toBe("null");
  });

  it("still shows the index pane at the bare app root", () => {
    // No deep-link segments → `matched []` → genuine bare root → index pane.
    expect(resolveAt("/app")).toBe("deep-link-test-index");
  });

  it("does NOT fall back to the index pane once the deferred tier has settled (unresolved ⇒ not-found, never the homepage)", () => {
    // With the tri-state route, an `unresolved` deep link stays `unresolved`
    // after settle — it is a genuine no-match, so `usePaneRoute` returns null
    // (the layout renders its NotFound surface) rather than the index pane. This
    // is the deliberate behavior change from the old time-scoped guard, which
    // reverted to the index fallback once loading completed.
    markDeferredLoadComplete();
    expect(resolveAt("/app/thing/123")).toBe("null");
  });

  it("pending → resolved: registering the target pane resolves the deep link to it", () => {
    // With only the index registered, `/app/thing/123` is unresolved ⇒ null (the
    // layout would show its loading fallback).
    setPath("/app/thing/123");
    const first = render(
      <TestSurface store={store} plugins={[testPlugin]}>
        <Probe basePath="/app" />
      </TestSurface>,
    );
    expect(first.getByTestId("out").textContent).toBe("null");
    first.unmount();

    // The deferred plugin arrives (target pane now registered) ⇒ the SAME URL
    // re-resolves to the target pane, not the index and not null.
    const second = render(
      <TestSurface store={store} plugins={[targetPlugin]}>
        <Probe basePath="/app" />
      </TestSurface>,
    );
    expect(second.getByTestId("out").textContent).toBe("deep-link-test-target");
  });
});

// Store-level tri-state route behavior, exercised directly on a `PaneStore`
// (no layout) so the no-clobber rule and the history.state round-trip are
// asserted in isolation from any renderer.
describe("tri-state route store", () => {
  it("no-clobber: an unresolved URL parse does NOT wipe a resolved non-empty route until settled", () => {
    const bgStore = createPaneStore({ live: false });
    bgStore.setBasePath("/app");
    // A route restored from persistence / prior navigation whose panes aren't in
    // the registry (cold boot: the deferred tier hasn't loaded them yet).
    bgStore.restoreRoute([{ paneId: "never-registered-pane", params: {} }]);
    expect(bgStore.getRouteState().kind).toBe("resolved");

    // Pre-settle: a pre-registry parse of an unresolvable URL must be ignored —
    // clobbering here is exactly the historical cold-boot bug.
    bgStore.syncRouteFromUrl("/nope/xyz");
    expect(bgStore.getRouteState().kind).toBe("resolved");

    // Post-settle: the genuinely dead link now wins, so it can surface as
    // NotFound instead of leaving a stale pane on screen.
    markDeferredLoadComplete();
    bgStore.syncRouteFromUrl("/nope/xyz");
    expect(bgStore.getRouteState().kind).toBe("unresolved");
  });

  it("history.state.pending round-trips a pending route without re-parsing the URL", () => {
    const liveStore = createPaneStore({ live: true });
    liveStore.setBasePath("/app");
    // A back/forward landing on a pending entry: the URL is preserved in
    // history.state.pending, so the store restores `unresolved` directly.
    setPath("/app/x/y");
    setHistoryState({ pending: "x/y" });
    liveStore.handleLocationChange();
    const state = liveStore.getRouteState();
    expect(state.kind).toBe("unresolved");
    expect(state.kind === "unresolved" ? state.rawPath : null).toBe("x/y");
  });

  it("stale-paneId: a resolved route whose panes never register resolves to neither the index nor a stale pane", () => {
    // Settled + a resolved non-empty route whose paneId is unknown to the
    // registry (a leftover history.state from an old bundle). `usePaneRoute`
    // returns null (the layout renders NotFound), NOT the index pane.
    markDeferredLoadComplete();
    // Deliberately NOT live: `handleLocationChange` early-returns for a
    // background store, so the restored route survives the surface's registry
    // sync instead of being re-parsed away from `window.location`.
    const staleStore = createPaneStore({ live: false });
    staleStore.setBasePath("/app");
    staleStore.restoreRoute([{ paneId: "stale-from-old-bundle", params: {} }]);
    const { getByTestId } = render(
      <TestSurface store={staleStore} plugins={[testPlugin]}>
        <Probe basePath="/app" />
      </TestSurface>,
    );
    expect(getByTestId("out").textContent).toBe("null");
  });
});
