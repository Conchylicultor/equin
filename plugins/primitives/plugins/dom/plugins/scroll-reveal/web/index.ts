import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useRevealOnActive,
  revealElement,
  REVEAL_BOUNDARY_ATTR,
  type RevealOptions,
} from "./internal/use-reveal-on-active";
export {
  focusElement,
  type FocusElementOptions,
} from "./internal/focus-element";

export default {
  description:
    "Reveal-on-activation primitive: useRevealOnActive() scrolls an element into view only when it TRANSITIONS active (or on explicit revealOnMount intent), never because it remounted already-active — so background data churn can't move the user's scroll. revealElement() is the imperative funnel for event handlers. focusElement(el, { reveal }) is the one spelling of element.focus(): focus never scrolls (preventScroll), and a reveal is stated at every call (true / RevealOptions when focus follows the user's navigation, false when focus is moved for them).",
  contributions: [],
} satisfies PluginDefinition;
