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
export { cloneWithScroll } from "./clone-with-scroll";
export type { CloneWithScrollOptions } from "./clone-with-scroll";
export { restoreScrollOffset } from "./restore-scroll-offset";
export { glideScroll } from "./glide-scroll";
export type { CubicBezier, GlideScrollOptions } from "./glide-scroll";
export { useScrollAcrossReload } from "./use-scroll-across-reload";
export { ScrollRevival } from "./scroll-revival";
export { announceNavigation } from "./announce-navigation";
export { findScrollParent } from "./internal/find-scroll-parent";
export type { FindScrollParentOptions } from "./internal/find-scroll-parent";

export default {
  description:
    "The scroll-owning primitive: the one sanctioned home for driving a scroll container. Stick-to-bottom streaming (useStickyScroll + JumpToBottomButton; content stamped FOLLOW_MOTION_ATTR is followed frame by frame while it animates), container-scoped scrollToBottom / scrollChildIntoView, a scroll glided frame by frame on a given CSS curve so it moves in step with a transition beside it (glideScroll), gesture-agnostic edge auto-scroll (useEdgeAutoScroll), scroll kept across a wholesale DOM swap (KeepScrollAcross, or restoreScrollOffset from a caller's own snapshot), the reader's anchor kept on screen across a commit that resizes content above it (KeepAnchorAcross), an element kept at its screen position across a re-layout (keepInPlace), a deep copy that keeps its scroll offsets (cloneWithScroll, for a stand-in drawn while content leaves, or — visibleOnly — a picture of only what shows), an inner scroller's offset kept across a page reload (useScrollAcrossReload, put back as async content arrives until reached or the reader takes over) and across an unloaded subtree's revival (ScrollRevival: an in-app tab mounted again), and the shared findScrollParent discovery.",
  contributions: [],
} satisfies PluginDefinition;
