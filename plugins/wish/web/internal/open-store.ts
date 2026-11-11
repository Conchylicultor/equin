import { useSyncExternalStore } from "react";
import {
  draftInsert,
  draftSeed,
  type TaskDraftInsert,
} from "@plugins/tasks/plugins/task-draft-form/web";

/**
 * Module-level store owning the Improve popover's open state + pending insertion.
 *
 * Replaces the former `Improve.OpenWithText` command: cross-plugin callers invoke
 * the plain exported `insertIntoWishDraft(text)` setter, and the single always-mounted
 * `WishButton` (`ActionBar.Item` — the global action bar mounts its two locations
 * mutually-exclusively, so it is never double-mounted) renders the popover as
 * controlled state read via `useSyncExternalStore`. The store is the single source of
 * truth — no local `useState`/effect in the button — so there is no setState-in-effect.
 *
 * What travels is an *insertion request*, not seed text: every caller is attaching
 * something (a picked UI element, a drawn screenshot) to whatever the user has
 * already drafted, which the popover's insert funnel adds at the caret. A plain
 * text value used to mean "replace the head card", which silently destroyed a
 * draft in progress.
 *
 * The snapshot is a stable object ref (a fresh object only on a real state change), so
 * `useSyncExternalStore` never loops — mirrors the composition/imperative-dialog stores.
 */
interface WishOpenState {
  open: boolean;
  insert: TaskDraftInsert | undefined;
}

// eslint-disable-next-line scoped-store/no-module-mutable-store -- one Wish popover per page: the global action bar mounts its button once (its two hosts are mutually exclusive), and every caller targets that one draft
let state: WishOpenState = { open: false, insert: undefined };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Open the Improve popover and insert `text` into the draft, preserving anything
 * already drafted. Fire-and-forget setter; each call is its own request, so
 * inserting the same snippet twice inserts it twice.
 */
export function insertIntoWishDraft(text: string): void {
  state = { open: true, insert: draftInsert(text) };
  emit();
}

/**
 * Open the Improve popover. `seed` is a suggested first request: it fills the
 * draft only when nothing is drafted yet, so work in progress is never mixed
 * with it (the onboarding tour's "Try it").
 */
export function openWish({ seed }: { seed?: string } = {}): void {
  state = {
    open: true,
    insert: seed === undefined ? state.insert : draftSeed(seed),
  };
  emit();
}

/** Controlled `onOpenChange` handler: opening keeps the pending insert, closing clears it. */
export function setWishOpen(open: boolean): void {
  if (open === state.open) return;
  state = open
    ? { open: true, insert: state.insert }
    : { open: false, insert: undefined };
  emit();
}

/** `useSyncExternalStore` subscribe. */
function subscribeWishOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` snapshot — the current open state (stable ref between changes). */
function getWishOpenState(): WishOpenState {
  return state;
}

/**
 * The popover's open state and pending insertion, re-rendering on change. A
 * static render reads the store as it stands (closed, unless something opened
 * it): it is never hydrated, so there is no client value to match.
 */
export function useWishOpenState(): WishOpenState {
  return useSyncExternalStore(
    subscribeWishOpen,
    getWishOpenState,
    getWishOpenState,
  );
}
