import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ReadOnlyBlocks } from "./components/read-only-blocks";
export type { ReadOnlyBlocksProps } from "./components/read-only-blocks";
export { buildForest } from "./build-forest";
export type { ForestBlock } from "./build-forest";
export type { ReadOnlyNode, BlockDiffKind } from "./node";

export default {
  description:
    "Faithful, non-editable renderer for a page block forest, with optional per-block diff highlighting. Reuses the editor's block-handle metadata + rich-text runs model without mounting Lexical.",
  contributions: [],
} satisfies PluginDefinition;
