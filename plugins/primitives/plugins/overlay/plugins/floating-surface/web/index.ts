import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  FloatingSurface,
  type FloatingSurfaceProps,
} from "./internal/floating-surface";

export default {
  description:
    "Focus-less anchored floating surface: positions a panel against any virtual anchor (a caret or selection rect, a hovered element, a point) via Floating UI (flip + scroll-follow), rendering the shared OverlayPanel inside a ViewportOverlay, without ever taking focus. A sibling to popover for transient surfaces that must not take focus (caret menus, hover previews, peeks, selection toolbars).",
  contributions: [],
} satisfies PluginDefinition;
