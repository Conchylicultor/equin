import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";
import type { PaneOptions, PaneStore } from "./pane";

// ---------------------------------------------------------------------------
// HistoryAdapter — the seam that keeps the pane primitive app-agnostic.
//
// The pane store is the single source of truth for what is on screen; the
// browser URL + `history.state` are a pure PROJECTION of it. The store never
// touches `window.history` directly. Instead it emits push/replace *intents*
// through the installed `HistoryAdapter`:
//
//   • setRoute / navigatePending  →  historyAdapter.commit(change)
//   • real browser back/forward   →  historyAdapter.restore()
//
// Standalone (and in tests) the `defaultHistoryAdapter` writes the pane's route
// payload verbatim and restores it straight back into the live store — today's
// behavior, unchanged. The tabs layer installs an app-aware adapter (via
// `setHistoryAdapter`) that additionally stamps `{ tabId, appId }` into each
// entry so a history entry is a COMPLETE snapshot of what the user was looking
// at, and restores the whole snapshot (refocus the tab, re-sync its app,
// restore the route) with zero URL parsing. See the pane + tabs CLAUDE.md.
// ---------------------------------------------------------------------------

/**
 * The serialized shape of one pane slot as it lives in `history.state.route`.
 * Mirrors what `setRoute` writes and what `handleLocationChange` reads back — a
 * pane's ephemeral `hint` is deliberately absent (never serialized).
 */
export type SerializedSlot = {
  paneId: string;
  params: Record<string, string>;
  options: PaneOptions;
  uuid: string;
};

/**
 * The pane's own route payload for one history entry — a resolved route or a
 * pending (unresolved) URL. The shell adapter widens this with `{ tabId, appId }`
 * when it writes; `handleLocationChange` reads only these keys and ignores the
 * rest, so the two runtimes never need to agree on the composite shape.
 */
export type PaneHistoryState =
  // `index`: the app's landing pane's keyed params (its `;view`), which live
  // beside the route — see `PaneStore.getIndexParams`.
  | { route: SerializedSlot[]; index?: Record<string, string> }
  | { pending: string };

/** An in-memory route change to project onto the browser. */
export interface LocationChange {
  /** Full pathname, base path already applied. */
  url: string;
  /** The pane's route payload for this entry. */
  state: PaneHistoryState;
  mode: "push" | "replace";
}

export interface HistoryAdapter {
  /** Project an in-memory route change onto the browser (URL + history entry). */
  commit(change: LocationChange): void;
  /** Real browser back/forward fired — rebuild the in-memory state from history. */
  restore(): void;
}

/**
 * The default adapter's `restore()` must reach the live PaneStore, which lives
 * in pane.ts. pane.ts already imports THIS module (for the adapter + commit), so
 * having history-sink import pane.ts back would form a runtime import cycle.
 * Instead pane.ts installs a thunk here at module-load time — the runtime
 * dependency stays one-way (pane.ts → history-sink), and the only edge back is
 * the type-only import above (erased at runtime).
 *
 * Empty (no fallback): a composition where pane.ts never loaded has no live
 * store at all, and `peekOrThrow()` says so by name instead of inventing one.
 */
export const liveStoreAccessorSink = defineInstallSink<() => PaneStore>({
  name: "pane.live-store-accessor",
  what: "the live-store accessor (installed by pane.ts at module load)",
});

/**
 * The standalone adapter — the behavior when no shell adapter is installed
 * (tests, and any composition without the tabs layer). `commit` writes the
 * route payload verbatim and announces it via `shell:navigate`; `restore`
 * rebuilds straight off the live store's `handleLocationChange` (which reads
 * `history.state`). It ignores any extra `{ tabId, appId }` keys a prior shell
 * adapter may have left, so swapping adapters mid-session never corrupts a read.
 */
export const defaultHistoryAdapter: HistoryAdapter = {
  commit({ url, state, mode }) {
    const method = mode === "replace" ? "replaceState" : "pushState";
    window.history[method](state, "", url);
    // Announce programmatic navigation as `shell:navigate` ONLY — never a
    // synthetic `popstate`. The single module-level `popstate` listener is
    // reserved for REAL browser back/forward → restore(); reactivity consumers
    // (usePathname, useActiveApp, pane-restore) all also listen to
    // `shell:navigate`, so they still update.
    window.dispatchEvent(new CustomEvent("shell:navigate"));
  },
  restore() {
    // A sample, not a subscription: `restore()` only ever runs from the
    // `popstate` listener, long after module load, and re-reads on every
    // traversal.
    liveStoreAccessorSink.peekOrThrow()().handleLocationChange();
  },
};

/**
 * The installed history adapter. Filled, never empty: with no shell adapter
 * installed the slot holds `defaultHistoryAdapter`, which is the standalone
 * behavior — so `peek()` at commit/restore time always has an adapter to call
 * and no consumer has to handle "none".
 */
export const historySink = defineInstallSink<HistoryAdapter>({
  name: "pane.history-adapter",
  fallback: defaultHistoryAdapter,
  what: "the history adapter (apps-core/tabs installs its app-aware one at provider mount)",
});

/**
 * Install a history adapter — the tabs layer's app-aware one, from its wiring
 * effect. The returned disposer puts the PREVIOUS occupant back (the default
 * adapter, unless something else was installed meanwhile), so teardown code
 * never has to remember what the standalone behavior was.
 */
export function setHistoryAdapter(adapter: HistoryAdapter): () => void {
  return historySink.install(adapter);
}
