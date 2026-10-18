import {
  appInstanceKey,
  legacyInstanceKey,
  mayAdoptLegacyPayload,
} from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import { isEmbeddedDocument } from "@plugins/primitives/plugins/embed/web";
import {
  currentRoutePath,
  stripBasePath,
  type PaneOptions,
  type PaneSlot,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { Placement } from "@plugins/apps-core/core";
import type { ActiveApp } from "@plugins/apps-core/web";

/**
 * One open app tab. Each tab owns its own {@link PaneStore} (independent route
 * + base path), so the same app can appear in multiple tabs and a background
 * tab keeps its route while another is focused. Exactly one store is `live` at
 * a time (the focused tab's); the tab manager flips liveness on focus switch.
 *
 * A tab carries NO spatial/placement state. The surface renders every tab under
 * the ONE {@link Placement} the surface is currently in (see
 * {@link PersistedTabs.mode}) — docked / windows / solo are mutually-exclusive
 * *surface* modes, not per-tab states. A single mode value makes "solo and
 * windows visible at once" structurally unrepresentable. Window geometry (only
 * meaningful in windows mode) lives in the floating plugin's own store, keyed by
 * tabId — never on the tab itself.
 */
export interface Tab {
  tabId: string;
  appId: string;
  store: PaneStore;
}

/**
 * Serialized slot shape persisted in sessionStorage. Mirrors the shape pane.ts
 * writes into `history.state.route` (paneId/params/options/uuid) so a restored
 * tab rebuilds an identical route via `store.restoreRoute(...)`.
 *
 * A pane's `hint` is NOT persisted — it is an optimistic mirror of server-owned
 * state that must not outlive the navigation that created it (see `Hint`).
 */
export interface PersistedSlot {
  paneId: string;
  params: Record<string, string>;
  // Mirrors PaneSlot.options (the opener-supplied partial). Persisted via JSON
  // (sessionStorage), which round-trips booleans/numbers/nested objects — so it
  // is the structured PaneOptions bag, not a string map.
  options: PaneOptions;
  uuid: string;
}

export interface PersistedTab {
  tabId: string;
  appId: string;
  route: PersistedSlot[];
  /**
   * The tab's current app-relative URL path, normalized SLASH-TRIMMED (no
   * leading/trailing slash; `""` for a bare app root) — the same normalization
   * `parseUrl` applies to a URL before matching (see {@link normalizeRawPath}).
   * Persisted for EVERY tab and used as the cold-boot discriminator: a resolved
   * tab stores the URL its `route` maps to, while a pending (unresolved) tab
   * stores `route: []` plus the rawPath it is waiting to resolve. On the next
   * boot, `bootTabs` compares this against the address bar — an exact match on
   * the focused tab restores its persisted `route` instantly (no spinner, no
   * registry), while a mismatch seeds a pending route instead of showing a stale
   * pane. Optional so payloads written before this field load unchanged.
   */
  rawPath?: string;
}

export interface PersistedTabs {
  tabs: PersistedTab[];
  /** Absent exactly when `tabs` is empty (a mode that `allowsEmpty`, the desktop). */
  focusedTabId?: string;
  /**
   * The single surface rendering mode (docked / windows / solo). Optional for
   * back-compat: payloads written before the per-surface mode (which stored a
   * per-tab `placement` instead) restore at the registry default mode.
   */
  mode?: Placement;
}

/**
 * sessionStorage key, namespaced per **app instance** — one running SPA
 * app-state, not one browser tab. An external navigation (bookmark, address
 * bar, link from another app) mints a fresh generation, so this key names an
 * empty slot and the tab set starts clean; a reload or a back/forward adopts
 * the generation the load belongs to and finds its tabs where it left them.
 * See `primitives/scope/app-instance`.
 */
function storageKey(): string {
  return appInstanceKey("app-tabs");
}

/**
 * MIGRATION (remove once no live session predates app instances): the
 * pre-generation `app-tabs:<tabId>` payload, read at most once ever.
 *
 * Whether this document is entitled to it at all is
 * {@link mayAdoptLegacyPayload}'s call — instance lifecycle, owned by
 * `primitives/scope/app-instance`, which carries the full rationale. Consuming it
 * (`removeItem`) is the consumer's half: it closes the same hole from the other
 * side, so the blob cannot outlive the migrating load and be picked up later.
 * The following `savePersistedTabs` re-homes the payload under the gen-scoped
 * key, so one preserving load carries the tab set across.
 */
function adoptLegacyPayload(): string | null {
  if (!mayAdoptLegacyPayload()) return null;
  const key = legacyInstanceKey("app-tabs");
  const raw = window.sessionStorage.getItem(key);
  if (raw !== null) window.sessionStorage.removeItem(key);
  return raw;
}

/** Serialize a store's current route to the persisted slot shape. */
export function serializeRoute(store: PaneStore): PersistedSlot[] {
  return store.getRoute().map((s: PaneSlot) => ({
    paneId: s.paneId,
    params: s.params,
    options: s.options,
    uuid: s.uuid,
  }));
}

/**
 * The single rawPath normalization for the persisted-tabs discriminator: strip
 * leading/trailing slashes, mapping the bare root ("/" or "") to "". Byte-for-byte
 * the same normalization `parseUrl` applies (its `rawPath` output), so a persisted
 * rawPath compares equal to `parseUrl(...).rawPath` for the same URL.
 */
export function normalizeRawPath(path: string): string {
  return path === "/" ? "" : path.replace(/^\/+|\/+$/g, "");
}

/**
 * The app-relative rawPath to persist for a tab, normalized as
 * {@link normalizeRawPath}. Derivation avoids `buildRouteUrl` (which throws on a
 * pane that is not registered yet — routine during the deferred-load window when
 * a background tab's app has not loaded):
 *
 * - **unresolved (pending)** ⇒ the store's own `rawPath`.
 * - **resolved bare root** ⇒ `""`.
 * - **resolved, live (focused) tab** ⇒ derived from the address bar: the live
 *   store's URL mirrors its resolved route, so the app-relative pathname IS the
 *   rawPath `buildRouteUrl(route)` would produce — but without touching the pane
 *   registry, so it never throws even for an instant-restored deep link whose
 *   panes have not loaded yet.
 * - **resolved, background tab** ⇒ carry forward the previously-persisted rawPath.
 *   A background tab's route is immutable while unfocused, so its rawPath still
 *   describes it; rebuilding from its (possibly unregistered) panes would throw.
 */
function rawPathForTab(
  tab: Tab,
  prevRawByTab: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const state = tab.store.getRouteState();
  if (state.kind === "unresolved") return state.rawPath;
  if (state.slots.length === 0) return "";
  if (tab.store.live) {
    return normalizeRawPath(
      stripBasePath(currentRoutePath(), tab.store.getBasePath()),
    );
  }
  return prevRawByTab.get(tab.tabId);
}

/**
 * Read the persisted tab set for this browser tab, or null if none. Throws on
 * a present-but-malformed key — we fail loud rather than silently resetting,
 * so a corruption bug surfaces instead of quietly losing the user's tabs.
 */
export function loadPersistedTabs(): PersistedTabs | null {
  if (typeof window === "undefined") return null;
  // An embedded document (`?embed=…` in either mode, see `primitives/embed`)
  // boots one tab from its URL and restores nothing: it shares this browser
  // tab's sessionStorage with the host page, and its instance is never
  // registered.
  if (isEmbeddedDocument()) return null;
  const raw =
    window.sessionStorage.getItem(storageKey()) ?? adoptLegacyPayload();
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as PersistedTabs;
  if (
    !Array.isArray(parsed.tabs) ||
    (typeof parsed.focusedTabId !== "string" &&
      !(parsed.focusedTabId === undefined && parsed.tabs.length === 0))
  ) {
    throw new Error(
      `Malformed persisted app-tabs payload under "${storageKey()}".`,
    );
  }
  return parsed;
}

/** Persist the live tab set (route serialized per store) to sessionStorage. */
export function savePersistedTabs(
  tabs: Tab[],
  focusedTabId: string | undefined,
  mode: Placement,
): void {
  if (typeof window === "undefined") return;
  // An embedded document persists nothing (see loadPersistedTabs): its tab set
  // is not restorable, and a write would land in the host tab's storage.
  if (isEmbeddedDocument()) return;
  // Read the prior payload so a resolved BACKGROUND tab can carry forward its
  // rawPath (see rawPathForTab). Safe: bootTabs already read this key once and
  // fails loud on genuine corruption, so a present key is well-formed here.
  const prev = loadPersistedTabs();
  const prevRawByTab = new Map<string, string | undefined>(
    (prev?.tabs ?? []).map((t) => [t.tabId, t.rawPath] as const),
  );
  const payload: PersistedTabs = {
    tabs: tabs.map((t) => ({
      tabId: t.tabId,
      appId: t.appId,
      route: serializeRoute(t.store),
      rawPath: rawPathForTab(t, prevRawByTab),
    })),
    focusedTabId,
    mode,
  };
  window.sessionStorage.setItem(storageKey(), JSON.stringify(payload));
}

/**
 * The base path for an app id, matching apps-layout's rule: an app whose base
 * path is "/" contributes an empty URL prefix; otherwise its base path IS the
 * prefix. Pane segments are app-local and the base path is the implicit prefix.
 */
export function appPathFor(appId: string, apps: readonly ActiveApp[]): string {
  const entry = apps.find((a) => a.id === appId);
  if (!entry) {
    throw new Error(`No registered app for id "${appId}".`);
  }
  return entry.app.basePath === "/" ? "" : entry.app.basePath;
}

/** The `Apps.App` contribution for an app id (for rendering its surface). */
export function appContributionFor(
  appId: string,
  apps: readonly ActiveApp[],
): ActiveApp {
  const app = apps.find((a) => a.id === appId);
  if (!app) {
    throw new Error(`No registered app for id "${appId}".`);
  }
  return app;
}
