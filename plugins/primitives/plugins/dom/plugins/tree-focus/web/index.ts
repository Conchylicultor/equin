import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useTreeFocus, type TreeFocus } from "./internal/use-tree-focus";

export default {
  description:
    "Whether DOM focus is inside a component's REACT tree, portals included: useTreeFocus() → { onFocusCapture, holdsFocus() }. Spread onFocusCapture on the component's root; holdsFocus() is true while the focused element is one whose focus event reached it — a popover or menu it opened (portaled to the body, outside it in the DOM) counts as inside. The question a focus-pull guard asks before taking focus back; never `root.contains(document.activeElement)`, which a portal defeats.",
  contributions: [],
} satisfies PluginDefinition;
