import { useEffect } from "react";
import type { ShortcutDescriptor } from "./types";
import { registerShortcuts } from "./dynamic-registry";

/**
 * Register PAGE-WIDE shortcuts from a component, for as long as it is mounted:
 * eligible whichever surface is focused — for chrome that owns the whole page
 * while it shows (a maximized demo's Esc to restore, the embedded app's
 * surface focused inside it). Same arbitration as every shortcut: an event
 * already handled or a text field claiming the key fires nothing, and the
 * highest `precedence` wins. Pass a stable (memoized) array: a new one
 * re-registers.
 */
export function usePageShortcuts(
  descriptors: Omit<ShortcutDescriptor, "surfaceId">[],
): void {
  useEffect(() => registerShortcuts(descriptors), [descriptors]);
}
