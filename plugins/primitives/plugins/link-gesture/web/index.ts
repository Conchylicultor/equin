import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  activationProps,
  browserTabAddressSink,
  clickProps,
  keepsOthers,
  linkGestureProps,
  linkProps,
  openInBrowserTab,
  type LinkGestureProps,
} from "./internal/link-gesture";

export default {
  description:
    "The browser's link gestures as spreadable handler props: plain click opens here, ⌘/Ctrl- and middle-click open the destination's URL in a new browser tab, ⌥/Alt-click opens it here keeping the others (keepsOthers: a pane open inserts beside the caller, a pane close removes only that pane). A <button> gets none of this for free, so every navigating control reads it from one place.",
} satisfies PluginDefinition;
