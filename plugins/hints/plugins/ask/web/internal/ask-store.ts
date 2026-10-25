import { useSyncExternalStore } from "react";
import { askCardStore, type AskCardSnapshot } from "./stores";

/**
 * Where the card is: `closed` (nothing on screen), `open` (the card), `min`
 * (minimized to its pill — only with a run in hand).
 */
export type AskMode = AskCardSnapshot["mode"];

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

const CARD_ENTRY = "card";

/**
 * The state at page load: the card as this tab left it (a reload keeps it —
 * open, minimized or closed, on the same run), which also settles the
 * once-per-load restore; else nothing on screen, the restore to come.
 */
function initialState(): AskState {
  const saved = askCardStore.read(CARD_ENTRY);
  if (saved.kind === "none")
    return { mode: "closed", conversationId: null, fresh: 0, restored: false };
  const { conversationId } = saved.value;
  // `min` is the pill, which only exists with a run in hand.
  const mode =
    saved.value.mode === "min" && conversationId === null
      ? "closed"
      : saved.value.mode;
  return { mode, conversationId, fresh: 0, restored: true };
}

// The page has ONE Ask equin card, mounted at Core.Root above every tab; the
// help menu's entry and the host both read it. Read from the tab's storage on
// first use, not at import.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: one Ask equin card per page, opened from the ? menu (a popover) and drawn by the Core.Root host, which share no React tree below the root.
let state: AskState | null = null;
const listeners = new Set<() => void>();

function current(): AskState {
  state ??= initialState();
  return state;
}

function set(next: Partial<AskState>): void {
  const prev = current();
  state = { ...prev, ...next };
  if (
    state.mode !== prev.mode ||
    state.conversationId !== prev.conversationId
  ) {
    // A refused write is already loud (the store's toast and report); the
    // card then just won't survive a reload.
    askCardStore.write(CARD_ENTRY, {
      mode: state.mode,
      conversationId: state.conversationId,
    });
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The card's state, reactive. */
export function useAskState(): AskState {
  return useSyncExternalStore(subscribe, current, current);
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
  set({ mode: current().conversationId === null ? "closed" : "min" });
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
    fresh: current().fresh + 1,
    restored: true,
  });
}

/**
 * The once-per-load restore decided: `conversationId` is the run to take
 * back as the pill (still working, or with an answer not yet seen), or null.
 * A no-op once a run was picked by hand.
 */
export function settleRestore(conversationId: string | null): void {
  const s = current();
  if (s.restored) return;
  if (conversationId === null || s.conversationId !== null) {
    set({ restored: true });
    return;
  }
  set({
    restored: true,
    conversationId,
    mode: s.mode === "closed" ? "min" : s.mode,
  });
}
