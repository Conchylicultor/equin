import { useSyncExternalStore } from "react";

/**
 * Where the card is: `closed` (nothing on screen), `open` (the card), `min`
 * (minimized to its pill — only with a run in hand).
 */
export type AskMode = "closed" | "open" | "min";

export interface AskState {
  mode: AskMode;
  /** The run the card holds; null — none yet (the empty card's suggestions). */
  conversationId: string | null;
  /**
   * Bumped by New question: the empty card remounts, so its suggestions are
   * picked again and the first-question box starts clean.
   */
  fresh: number;
  /**
   * The once-per-load restore is decided (taken back, or nothing to take
   * back), or a run was picked by hand — which must not be overtaken by it.
   */
  restored: boolean;
}

// The page has ONE Ask equin card, mounted at Core.Root above every tab; the
// help menu's entry and the host both read it.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: one Ask equin card per page, opened from the ? menu (a popover) and drawn by the Core.Root host, which share no React tree below the root.
let state: AskState = {
  mode: "closed",
  conversationId: null,
  fresh: 0,
  restored: false,
};
const listeners = new Set<() => void>();

function set(next: Partial<AskState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The card's state, reactive. */
export function useAskState(): AskState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Open the card — on the run in hand, or empty. */
export function openAsk(): void {
  set({ mode: "open" });
}

/** Show run `conversationId` in the open card (a question just started). */
export function showRun(conversationId: string): void {
  set({ mode: "open", conversationId, restored: true });
}

/** Minimize: to the pill with a run in hand, else the card just closes. */
export function minimizeAsk(): void {
  set({ mode: state.conversationId === null ? "closed" : "min" });
}

/** The pill: back to the card. */
export function restoreCard(): void {
  set({ mode: "open" });
}

/**
 * Let go of the run (New question, or after Done): it stays in the Agent
 * Manager; the card starts empty again.
 */
export function releaseRun(opts: { close: boolean }): void {
  set({
    mode: opts.close ? "closed" : "open",
    conversationId: null,
    fresh: state.fresh + 1,
    restored: true,
  });
}

/**
 * The once-per-load restore decided: `conversationId` is the run to take
 * back as the pill (still working, or with an answer not yet seen), or null.
 * A no-op once a run was picked by hand.
 */
export function settleRestore(conversationId: string | null): void {
  if (state.restored) return;
  if (conversationId === null || state.conversationId !== null) {
    set({ restored: true });
    return;
  }
  set({
    restored: true,
    conversationId,
    mode: state.mode === "closed" ? "min" : state.mode,
  });
}
