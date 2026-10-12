import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MarkdownEnhancerSlot } from "@plugins/primitives/plugins/markdown/web";
import { InlineTextWalkerSlot } from "@plugins/primitives/plugins/inline-text/web";
import { FileLinksEnhancer } from "./internal/file-links-enhancer";
import { FileLinksInlineWalker } from "./internal/file-links-inline-walker";
import { CodeEnhancer } from "./internal/code-enhancer";
import { ImgEnhancer } from "./internal/img-enhancer";

export default {
  description:
    "Conversation-scoped markdown enhancers: file-links, inline code enhancements, and image proxying.",
  contributions: [
    MarkdownEnhancerSlot({
      id: "file-links",
      order: 10,
      Component: FileLinksEnhancer,
    }),
    // Plain-text (non-markdown) counterpart of the file-links markdown
    // enhancer, registered after active-data (order 10) so chips stay opaque
    // and remaining file paths still linkify. Same useFileTarget resolution.
    InlineTextWalkerSlot({
      id: "file-links",
      order: 10,
      Component: FileLinksInlineWalker,
    }),
    MarkdownEnhancerSlot({
      id: "code-inline",
      order: 20,
      Component: CodeEnhancer,
    }),
    MarkdownEnhancerSlot({
      id: "img-proxy",
      order: 30,
      Component: ImgEnhancer,
    }),
  ],
} satisfies PluginDefinition;
