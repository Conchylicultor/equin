import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { appInstanceId } from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
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

const persistedSlotSchema = z.object({
  paneId: z.string(),
  params: z.record(z.string()),
  options: z.custom<PaneOptions>((v) => typeof v === "object" && v !== null),
  uuid: z.string(),
});

const persistedTabsSchema = z
  .object({
    tabs: z.array(
      z.object({
        tabId: z.string(),
        appId: z.string(),
        route: z.array(persistedSlotSchema),
        rawPath: z.string().optional(),
      }),
    ),
    focusedTabId: z.string().optional(),
    mode: z.custom<Placement>((v) => typeof v === "string").optional(),
  })
  // Absent focusedTabId is only valid with no tabs (a mode that `allowsEmpty`).
  .refine((p) => p.focusedTabId !== undefined || p.tabs.length === 0);

const LEGACY_PREFIX = "app-tabs:";

/**
 * The tab set, one entry per **app instance** (id = `appInstanceId()`) - one
 * running SPA app-state, not one browser tab. An external navigation (bookmark,
 * address bar, link from another app) mints a fresh generation, so its id names
 * an empty slot and the tab set starts clean; a reload or a back/forward adopts
 * the generation the load belongs to and finds its tabs where it left them.
 * See `primitives/scope/app-instance`.
 */
const tabsStore = defineStore({
  owner: "apps-core.tabs",
  label: "Open tabs",
  area: "session",
  cap: "512 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: persistedTabsSchema,
  // MIGRATION (remove once no live session predates the web-storage envelope):
  // `app-tabs:<tabId>:<generation>` raw payloads become entries of this store.
  // The older pre-generation `app-tabs:<tabId>` has no instance to belong to
  // and is dropped.
  legacy: {
    match: (key) => key.startsWith(LEGACY_PREFIX),
    adopt: (key, raw) => {
      const id = key.slice(LEGACY_PREFIX.length);
      if (!id.includes(":")) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      return { id, value, ts: Date.now() };
    },
  },
});

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
 * Read the persisted tab set for this app instance, or null if none. A
 * present-but-malformed entry is dropped and reported by the store (never
 * silently handed back), then reads as none.
 */
export function loadPersistedTabs(): PersistedTabs | null {
  if (typeof window === "undefined") return null;
  // An embedded document (`?embed=…` in either mode, see `primitives/embed`)
  // boots one tab from its URL and restores nothing: it shares this browser
  // tab's sessionStorage with the host page, and its instance is never
  // registered.
  if (isEmbeddedDocument()) return null;
  const read = tabsStore.read(appInstanceId());
  return read.kind === "value" ? read.value : null;
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
  // rawPath (see rawPathForTab).
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
  // A refused write (full, blocked) is reported by the store itself.
  tabsStore.write(appInstanceId(), payload);
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
