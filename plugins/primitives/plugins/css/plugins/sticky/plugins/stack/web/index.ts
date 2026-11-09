import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  StickyStack,
  StickyStackItem,
  StickyStackBranch,
  stickyStackTop,
  DEFAULT_MAX_STACKED,
  type StickyStackProps,
  type StickyStackItemProps,
  type StickyStackBranchProps,
} from "./internal/sticky-stack";

export default {
  description:
    "Sticky-stack layout primitive: <StickyStack>/<StickyStackItem> pin N sticky siblings sharing one containing block, each below the ones before it (capped; degrades to the swap hand-off).",
  contributions: [],
} satisfies PluginDefinition;
