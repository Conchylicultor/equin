import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  PopupAnchorRest,
  PopupOpenScope,
  usePopupAnchorAtRest,
  useReportPopupOpen,
} from "./internal/popup-open";
export {
  anyPopupOpen,
  subscribeOpenPopups,
  usePublishOpenPopup,
} from "./internal/page-popups";

export default {
  description:
    "Typed 'is a popup open inside me' signal: PopupOpenScope aggregates every popup opened under it and hands the boolean to its render-prop child; ui-kit's Root wrappers publish it via useReportPopupOpen. Page-wide, the same Roots publish through usePublishOpenPopup, read as anyPopupOpen / subscribeOpenPopups: whether any popup is open on the page, whatever region it is in (the hints engine holds a tip back meanwhile). And the reverse signal, PopupAnchorRest / usePopupAnchorAtRest: whether the region a popup is opened from is at rest (a FloatingAction mid-morph is not), so a popover requested meanwhile waits and is laid out against where its trigger ends up. Replaces CSS selectors that named a popup library's own attribute contract. Sits below ui-kit (imports only react) so ui-kit can consume it without a cycle.",
  contributions: [],
} satisfies PluginDefinition;
