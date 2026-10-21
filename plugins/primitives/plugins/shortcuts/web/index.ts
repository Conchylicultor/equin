import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ShortcutManager } from "./internal/shortcut-manager";
import { Shortcuts } from "./slots";

export { Shortcuts } from "./slots";
export { defineShortcut } from "./internal/define-shortcut";
export { useSurfaceShortcuts } from "./internal/use-surface-shortcut";
export {
  setFocusedSurfaceId,
  getFocusedSurfaceId,
  useFocusedSurfaceId,
  subscribeFocusedSurface,
} from "./internal/focused-surface";
export { formatShortcutLabel } from "./internal/format-keys";
export { isModHeld } from "./internal/parse-keys";
export { targetClaimsKey } from "./internal/target-claims-key";
export type { ShortcutDescriptor } from "./internal/types";

export default {
  description:
    "Central keyboard shortcut registry. Plugins contribute shortcuts via defineShortcut(); a single keydown listener dispatches to the active handler.",
  loadBearing: true,
  contributions: [Core.Root({ component: ShortcutManager })],
  slots: Shortcuts,
} satisfies PluginDefinition;
