import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { isChromeGesture } from "./internal/chrome-gesture";

export default {
  description:
    "Whether a pointer gesture a chrome surface caught (a drag handle's press, a header's double-click) is its own: isChromeGesture(event) — false for an event bubbled through React from a portal (a popover opened from the surface, outside it in the DOM) and for one landing in text entry (input, textarea, select, editable region), where a press-and-drag selects text and a double-click picks a word. Read by the sortable-list pointer sensor and the pane header's double-click.",
  contributions: [],
} satisfies PluginDefinition;
