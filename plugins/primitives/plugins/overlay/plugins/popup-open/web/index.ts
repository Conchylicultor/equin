import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  PopupAnchorRest,
  PopupOpenScope,
  usePopupAnchorAtRest,
  useReportPopupOpen,
} from "./internal/popup-open";

export default {
  description:
    "Typed 'is a popup open inside me' signal: PopupOpenScope aggregates every popup opened under it and hands the boolean to its render-prop child; ui-kit's Root wrappers publish it via useReportPopupOpen. And the reverse signal, PopupAnchorRest / usePopupAnchorAtRest: whether the region a popup is opened from is at rest (a FloatingAction mid-morph is not), so a popover requested meanwhile waits and is laid out against where its trigger ends up. Replaces CSS selectors that named a popup library's own attribute contract. Sits below ui-kit (imports only react) so ui-kit can consume it without a cycle.",
  contributions: [],
} satisfies PluginDefinition;
