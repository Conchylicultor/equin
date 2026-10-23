import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useStickyScroll } from "./use-sticky-scroll";
export { FOLLOW_MOTION_ATTR } from "./follow-motion";
export type {
  StickyScrollHandle,
  StickyScrollPersist,
  UseStickyScrollOptions,
} from "./use-sticky-scroll";
export { JumpToBottomButton } from "./jump-to-bottom-button";
export type {
  JumpToBottomButtonProps,
  JumpToBottomView,
} from "./jump-to-bottom-button";
export { scrollToBottom, scrollToTop } from "./scroll-to-bottom";
export type { ScrollToBottomOptions } from "./scroll-to-bottom";
export { scrollChildIntoView } from "./scroll-child-into-view";
export type {
  ScrollAlign,
  ScrollChildIntoViewOptions,
} from "./scroll-child-into-view";
export { useEdgeAutoScroll } from "./use-edge-auto-scroll";
export type {
  EdgeAutoScroll,
  EdgeScrollSurface,
  UseEdgeAutoScrollOptions,
} from "./use-edge-auto-scroll";
export { KeepScrollAcross } from "./keep-scroll-across";
export { KeepAnchorAcross } from "./keep-anchor-across";
export type { KeepAnchorAcrossProps } from "./keep-anchor-across";
export { keepInPlace } from "./keep-in-place";
export type { KeepScrollAcrossProps } from "./keep-scroll-across";
export {
  captureDocumentScroll,
  restoreDocumentScroll,
} from "./carry-document-scroll";
export type { DocumentScroll } from "./carry-document-scroll";
export { announceNavigation } from "./announce-navigation";
export { findScrollParent } from "./internal/find-scroll-parent";
export type { FindScrollParentOptions } from "./internal/find-scroll-parent";

export default {
  description:
    "The scroll-owning primitive: the one sanctioned home for driving a scroll container. Stick-to-bottom streaming (useStickyScroll + JumpToBottomButton; content stamped FOLLOW_MOTION_ATTR is followed frame by frame while it animates), container-scoped scrollToBottom / scrollChildIntoView, gesture-agnostic edge auto-scroll (useEdgeAutoScroll), scroll kept across a wholesale DOM swap (KeepScrollAcross), the reader's anchor kept on screen across a commit that resizes content above it (KeepAnchorAcross), an element kept at its screen position across a re-layout (keepInPlace), scroll carried from one document to the next (captureDocumentScroll / restoreDocumentScroll, for a reloaded same-origin iframe), and the shared findScrollParent discovery.",
  contributions: [],
} satisfies PluginDefinition;
