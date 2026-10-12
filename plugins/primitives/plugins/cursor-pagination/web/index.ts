import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ScrollSentinel } from "./internal/scroll-sentinel";
export type { ScrollSentinelProps } from "./internal/scroll-sentinel";
export { useInfiniteScroll } from "./internal/use-infinite-scroll";
export type {
  InfiniteScrollOptions,
  InfiniteScrollHandle,
} from "./internal/use-infinite-scroll";
export { InfiniteScrollFooter } from "./internal/infinite-scroll-footer";
export type { InfiniteScrollFooterProps } from "./internal/infinite-scroll-footer";

export default {
  description:
    "Cursor-pagination primitive: the error-gated useInfiniteScroll observer + InfiniteScrollFooter (load-more spinner / Retry / sentinel), and the ScrollSentinel component. The pages themselves come from a paged live read (useLive(...).loadMore).",
  contributions: [],
} satisfies PluginDefinition;
