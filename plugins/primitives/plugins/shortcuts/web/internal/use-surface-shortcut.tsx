import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import type { ShortcutDescriptor } from "./types";
import { useRegisteredShortcuts } from "./use-registered-shortcuts";

/**
 * Register surface-scoped shortcuts from inside a surface subtree. Each becomes
 * eligible ONLY while its surface is the focused surface. `defineShortcut` is a
 * static contribution and can't read React context, so surface scoping must
 * register dynamically from where the surface id is known. The array need not
 * be memoized: shortcuts re-register only when what they are changes, and
 * `handler` / `when` are read from the latest render.
 */
export function useSurfaceShortcuts(
  descriptors: Omit<ShortcutDescriptor, "surfaceId">[],
): void {
  const surfaceId = useSurfaceTabId();
  useRegisteredShortcuts(descriptors, surfaceId);
}
