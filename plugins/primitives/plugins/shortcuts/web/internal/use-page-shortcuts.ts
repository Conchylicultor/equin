import type { ShortcutDescriptor } from "./types";
import { useRegisteredShortcuts } from "./use-registered-shortcuts";

/**
 * Register PAGE-WIDE shortcuts from a component, for as long as it is mounted:
 * eligible whichever surface is focused — for chrome that owns the whole page
 * while it shows (a maximized demo's Esc to restore, the embedded app's
 * surface focused inside it). Same arbitration as every shortcut: an event
 * already handled or a text field claiming the key fires nothing, and the
 * highest `precedence` wins. The array need not be memoized: shortcuts
 * re-register only when what they are changes, and `handler` / `when` are
 * read from the latest render.
 */
export function usePageShortcuts(
  descriptors: Omit<ShortcutDescriptor, "surfaceId">[],
): void {
  useRegisteredShortcuts(descriptors, undefined);
}
