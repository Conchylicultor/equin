import {
  currentRoutePath,
  type HistoryAdapter,
  type LocationChange,
  type PaneHistoryState,
  type RouteState,
  type SerializedSlot,
} from "@plugins/primitives/plugins/pane/web";
import {
  getAppInstanceId,
  readAppInstance,
  stampAppInstance,
} from "@plugins/primitives/plugins/scope/plugins/app-instance/web";
import { resolveAppForPath, type ActiveApp } from "@plugins/apps-core/web";
import { embedMode, embedUrl } from "@plugins/primitives/plugins/embed/web";
import type { Tab } from "./tabs-store";

// ---------------------------------------------------------------------------
// The shell (app-aware) history adapter — the tabs layer's implementation of
// the pane primitive's `HistoryAdapter` seam.
//
// The pane store treats the browser as a projection of ONE tab's route. The
// shell widens that: a history entry is a COMPLETE snapshot of what the user was
// looking at — `{ tabId, appId, route | pending }`. `commit` stamps the focused
// tab's `{ tabId, appId }` onto every entry the pane store writes; `restore`
// reads the whole snapshot back on a real browser back/forward and rebuilds it
// (refocus the tab, re-sync its app in place, restore the route) with ZERO URL
// parsing. Chrome identity (the `focusedApp` signal) and content (the focused
// tab's `appId`) both derive from the one `restore()` mutation, so they can
// never race the URL — the theme/content divergence class is impossible.
//
// This file is the ONE sanctioned low-level `window.history` writer in the tabs
// layer (see the `no-raw-history-nav` lint exemption).
// ---------------------------------------------------------------------------

/**
 * The composite `history.state` shape the shell writes: the pane's route payload
 * widened with the focused tab's identity, plus the **app instance** that wrote
 * it. `handleLocationChange` reads only `route`/`pending` and ignores the extra
 * keys, so the pane primitive never needs to know about this shape.
 *
 * `appInstance` is what lets a cold boot tell "this entry belongs to the state I
 * am restoring" from "this entry belongs to a different running app-state" — it
 * is the *which* half of the fresh-vs-preserve decision (the nav type is the
 * *whether* half). See `primitives/scope/app-instance`.
 */
type CompositeState = PaneHistoryState & {
  tabId?: string;
  appId?: string;
  appInstance?: string;
};

/**
 * The hooks into the tab manager the adapter needs. All reads go through
 * getters (never captured snapshots) because `TabsProvider` keeps its
 * tabs/focus in hybrid refs written both in render and imperatively inside the
 * action callbacks — the adapter must always see the latest, not a stale
 * closure. The mutation callbacks deliberately expose only the history-free
 * variants: restoration must NEVER write history (the browser already advanced
 * it), so there is no way for the adapter to re-enter the commit path.
 */
export interface ShellHistoryDeps {
  /**
   * The focused tab's `{ tabId, appId }`; null before any tab has mounted, and
   * while the surface holds no tab (a mode that `allowsEmpty`, the desktop).
   */
  focused(): { tabId: string; appId: string } | null;
  /** All open tabs, to locate a snapshot's originating tab by id. */
  tabs(): readonly Tab[];
  /** Registered apps, for URL→app resolution in the legacy branch. */
  apps(): readonly ActiveApp[];
  /** Refocus an EXISTING tab by id WITHOUT writing history (no app rebuild). */
  refocus(tabId: string): void;
  /**
   * Rebuild `tabId`'s store bound to `appId` in place WITHOUT writing history,
   * making it the live focused tab. Its route is restored separately (step 7) —
   * this only swaps the app, keeping one code path for the route.
   */
  rebuildAppInPlace(tabId: string, appId: string): void;
  /**
   * Mint a tab on `appId` and make it the live focused one WITHOUT writing
   * history — restoring onto an EMPTY surface, where there is no focused tab to
   * apply the snapshot to. Bounded: it only runs while the set is empty.
   */
  mintForRestore(appId: string): void;
  /** Restore the live (focused) store's route from the just-updated `history.state`. */
  restoreLiveRoute(): void;
  /** Publish the focused app id to the chrome-identity module store. */
  setFocusedApp(appId: string | undefined): void;
  /** Persist the tab set to sessionStorage. */
  persist(): void;
}

/**
 * Serialize a resolved/pending pane route into the payload half of a history
 * entry — the shape `handleLocationChange` reads back. A pane's `hint` is
 * deliberately absent (never serialized).
 */
export function serializePaneState(state: RouteState): PaneHistoryState {
  if (state.kind === "unresolved") return { pending: state.rawPath };
  const route: SerializedSlot[] = state.slots.map((s) => ({
    paneId: s.paneId,
    params: s.params,
    options: s.options,
    uuid: s.uuid,
  }));
  return { route };
}

/**
 * Build the shell history adapter over `deps`. Installed by `TabsProvider` via
 * `setHistoryAdapter(...)` in its wiring effect, whose cleanup is the disposer
 * that install returns — putting the default adapter back on unmount.
 */
export function makeShellHistoryAdapter(
  deps: ShellHistoryDeps,
): HistoryAdapter {
  function commit({ url, state, mode }: LocationChange): void {
    const focused = deps.focused();
    // Merge the focused-tab snapshot into the route payload so the entry is a
    // complete picture of what was on screen: which tab, which app, which route
    // — and which app INSTANCE those ids belong to, so a later cold boot can
    // tell whether they name its own state or a foreign one.
    // (Absent on the empty surface — the desktop with every window closed,
    // whose bare-`/` entry names no tab — and pre-mount, when commit never
    // runs; an unstamped entry stays verbatim rather than carrying half a
    // snapshot.)
    const composite: CompositeState = focused
      ? stampAppInstance({
          ...state,
          tabId: focused.tabId,
          appId: focused.appId,
        })
      : state;
    const method = mode === "replace" ? "replaceState" : "pushState";
    // The pane store builds `url` from the route alone, so the `?embed=…` an
    // embedded document was opened with would be gone after its first
    // navigation. Re-stamping it keeps the address honest: a reload of the
    // frame after in-frame clicks comes back embedded the same way. (The
    // chrome itself keys on the boot-time read, not on this — see
    // `primitives/embed`.)
    const embed = embedMode();
    window.history[method](
      composite,
      "",
      embed === undefined ? url : embedUrl(url, embed),
    );
    // Programmatic navigation announces `shell:navigate` ONLY — never a
    // synthetic popstate (that is reserved for real browser back/forward).
    window.dispatchEvent(new CustomEvent("shell:navigate"));
  }

  function restore(): void {
    // Runs AFTER the browser already updated the URL + `history.state`.
    const raw = (window.history.state ?? {}) as CompositeState;
    const focused = deps.focused();

    // 1. FOREIGN-INSTANCE entry: the snapshot names an app instance that is not
    //    the one running here, so its `tabId` addresses a tab set this document
    //    never had — trusting it would refocus/rebuild against an id that means
    //    nothing here. Same-document popstate can only reach entries this
    //    instance itself wrote, so in normal operation this never fires; it
    //    guards the genuinely weird (a duplicated tab, an engine replaying a
    //    foreign entry into a live document). Degrade into the URL-reparse
    //    branch below rather than throwing — this runs inside a user-facing
    //    popstate handler, where the URL is always a usable second source.
    const entryInstance = readAppInstance(raw);
    const foreignInstance =
      entryInstance !== undefined && entryInstance !== getAppInstanceId();

    // 2. Legacy / `{}` entry: no snapshot was stamped — a pre-deploy history
    //    entry, or apps-layout's canonicalization redirect wrote `{}`. Fall back
    //    to URL reparsing: resolve the app that owns the current URL and
    //    reconcile the focused tab to it in place (no history write). A foreign
    //    entry takes the same path, for the same reason: the URL is the only
    //    part of it this instance can trust.
    if (!raw.tabId || !raw.appId || foreignInstance) {
      const resolved = resolveAppForPath(currentRoutePath(), deps.apps());
      const appId = resolved?.app.id ?? focused?.appId;
      // No app owns the URL and no tab is focused: the empty surface's own
      // entry (bare `/`) — it stays empty.
      if (appId === undefined) return;
      if (!focused) deps.mintForRestore(appId);
      else if (appId !== focused.appId)
        deps.rebuildAppInPlace(focused.tabId, appId);
      deps.restoreLiveRoute();
      deps.setFocusedApp(appId);
      deps.persist();
      return;
    }

    const target = deps.tabs().find((t) => t.tabId === raw.tabId);

    // 4. Closed-tab entry: the snapshot's tab was closed since it was written.
    //    Never mint it back — a dead tabId can't be revived, and minting under
    //    repeated back/forward would grow the tab set unboundedly. Apply the
    //    snapshot's `{ appId, route | pending }` to the CURRENT focused tab.
    //    On an empty surface there is no focused tab to apply it to: mint one.
    if (!target) {
      if (!focused) deps.mintForRestore(raw.appId);
      else if (raw.appId !== focused.appId) {
        deps.rebuildAppInPlace(focused.tabId, raw.appId);
      }
      deps.restoreLiveRoute();
      deps.setFocusedApp(raw.appId);
      deps.persist();
      return;
    }

    // 5–6. Foreground the snapshot's tab under the snapshot's app.
    //   - app differs ⇒ rebuild its store bound to `raw.appId` (this both
    //     refocuses the tab AND swaps its app in place — the theme/content
    //     desync fix). No history write.
    //   - app matches, tab not focused ⇒ a plain refocus (no store rebuild).
    //   - app matches, tab already focused ⇒ nothing; step 7 restores the route.
    if (target.appId !== raw.appId) {
      deps.rebuildAppInPlace(target.tabId, raw.appId);
    } else if (focused?.tabId !== target.tabId) {
      deps.refocus(target.tabId);
    }

    // 7. Restore the route into the now-live, now-correct-app store — one code
    //    path for resolved and pending alike (`handleLocationChange` reads
    //    `route`/`pending` off `history.state`).
    deps.restoreLiveRoute();

    // 8. Publish chrome identity synchronously, then persist the new focus/app.
    deps.setFocusedApp(raw.appId);
    deps.persist();
  }

  return { commit, restore };
}
