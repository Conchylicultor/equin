import { useSyncExternalStore } from "react";
import type { WindowId } from "../hooks/use-floating-windows";
import type { OverviewSlot } from "./overview-layout";

// The overview (exposé) while it is open: each visible window's slot in the
// grid. Opened by a command (the F3 shortcut, the shelf's tray button), read by
// every window's motion (its transform) and by the overview layer (labels, the
// click targets) — a module-global channel for the same reason the snap preview
// is one: one desktop per page, writer and readers in unrelated subtrees.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the one desktop's open overview, written by commands and read by every window's style and the overview layer in other subtrees (mirrors the snap-preview channel).
let slots: ReadonlyMap<WindowId, OverviewSlot> | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Open the overview at these slots (none → it stays closed). */
export function showOverview(next: readonly OverviewSlot[]): void {
  if (next.length === 0) return;
  slots = new Map(next.map((s) => [s.id, s]));
  notify();
}

/** Close the overview (no-op when closed). */
export function hideOverview(): void {
  if (slots === null) return;
  slots = null;
  notify();
}

/** One-shot: whether the overview is open — commands only. */
export function isOverviewOpen(): boolean {
  return slots !== null;
}

/** Reactive read of the open overview's slots (null while closed). */
export function useOverviewSlots(): ReadonlyMap<WindowId, OverviewSlot> | null {
  return useSyncExternalStore(
    subscribe,
    () => slots,
    () => slots,
  );
}

/** Reactive: whether the overview is open (the shelf and wallpaper react to it). */
export function useOverviewActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => slots !== null,
    () => false,
  );
}
