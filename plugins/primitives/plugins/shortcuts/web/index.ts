import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ShortcutManager } from "./internal/shortcut-manager";
import { Shortcuts } from "./slots";

export { Shortcuts } from "./slots";
export { defineShortcut } from "./internal/define-shortcut";
export { useSurfaceShortcuts } from "./internal/use-surface-shortcut";
export { usePageShortcuts } from "./internal/use-page-shortcuts";
export { usePlayPauseShortcut } from "./internal/use-play-pause-shortcut";
export {
  setFocusedSurfaceId,
  getFocusedSurfaceId,
} from "./internal/focused-surface";
export {
  defineSurfaceSignal,
  useSurfaceSignal,
  useFocusedSurfaceSignal,
  type SurfaceSignal,
} from "./internal/surface-signal";
export { formatShortcutLabel } from "./internal/format-keys";
export { isModHeld } from "./internal/parse-keys";
export { targetClaimsKey } from "./internal/target-claims-key";
export type { ShortcutDescriptor } from "./internal/types";

export default {
  description:
    "Central keyboard shortcut registry. Plugins contribute shortcuts via defineShortcut(); a single keydown listener dispatches to the active handler. Owns the page's focused surface, and surface signals keyed by it (defineSurfaceSignal: a surface publishes a value, global chrome reads the focused surface's — only when both render in the same plugin scope).",
  loadBearing: true,
  contributions: [Core.Root({ component: ShortcutManager, scope: "page" })],
  slots: Shortcuts,
} satisfies PluginDefinition;
