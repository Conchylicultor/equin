import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  tabOriginLabel,
  useTabOrigin,
  type TabOrigin,
  type TabStamp,
} from "./internal/tab-origin";
export { TabOriginBadge } from "./components/tab-origin-badge";

export default {
  description:
    "Which browser tab raised something, in words: useTabOrigin(stamp) reads a stamped tab id and page URL as this tab, or another one — the app its page belongs to (the menu-bar panel included) and whether that tab is still open (tab-id's presence) — and tabOriginLabel / TabOriginBadge say it ('this tab', 'another Places tab', 'closed Places tab').",
  contributions: [],
} satisfies PluginDefinition;
