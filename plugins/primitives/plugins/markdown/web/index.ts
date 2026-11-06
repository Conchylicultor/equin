import { MarkdownEnhancerSlot } from "./internal/markdown";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Markdown,
  MarkdownEnhancerSlot,
  useMarkdownLoaded,
} from "./internal/markdown";
export {
  MarkdownEnhancementContext,
  useMarkdownEnhancement,
} from "./internal/enhancement-context";
export type {
  MarkdownEnhancement,
  RemarkPlugins,
} from "./internal/enhancement-context";
export { langFromClassName, nodeToText } from "./internal/helpers";
export { InlineCode } from "./internal/inline-code";

export default {
  description:
    "Shared markdown renderer with slot-based enhancers. Consumers write <Markdown>{text}</Markdown>; context-specific behaviors auto-activate via Markdown.Enhancer contributions.",
  contributions: [],
  slots: { enhancer: MarkdownEnhancerSlot },
} satisfies PluginDefinition;
