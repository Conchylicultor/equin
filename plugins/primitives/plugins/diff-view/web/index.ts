import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DiffView, DiffRenderer } from "./components/diff-view";
export { TextDiff } from "./components/text-diff";
export { ImageDiffView } from "./components/image-diff-view";
export { DiffOrImageView } from "./internal/diff-or-image-view";
export { buildSideTokenMap, useDiffTokens } from "./use-diff-tokens";
export type { DiffTokens, ShikiTokenNode } from "./use-diff-tokens";

export default {
  description:
    "Generic side-by-side / text diff renderer primitive. Exposes TextDiff (two in-memory strings), DiffView/DiffOrImageView (worktree file vs a git ref), DiffRenderer, and the shiki token helpers.",
  contributions: [],
} satisfies PluginDefinition;
