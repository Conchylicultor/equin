import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { applyMarkdownToBlock, applyMarkdownToPage } from "./internal/apply";
export type { ApplyBlockOptions, ApplyReport } from "./internal/apply";
export { readBlockAsMarkdown, readPageAsMarkdown } from "./internal/read";
export type { ReadBlockOptions } from "./internal/read";
// The block→page resolution + row load the two entry points above begin with,
// exported for a POLICY consumer that must decide about a block before naming it
// as a root — an ancestor-chain check, or a rank against its last child. Reading
// rows is not the same authority as writing them, and re-deriving the block→page
// rule per consumer is what would drift.
export { loadBlockScope } from "./internal/read";
export type { BlockScope, BlockScopePageRow } from "./internal/read";
// The ONE assembly of the markdown contract's two halves (handle set + protected
// spans). A consumer that parses a document destined for this page's forest —
// `annotations/agent-access`'s creates-only append — must parse it with the same
// context the read and the applier use, or it would be writing a second dialect
// that the next read round-trips differently.
export { serverMarkdownContext } from "./internal/markdown-context";

export default {
  description:
    "Apply an edited markdown document onto an existing page's block forest without re-minting block ids: the block-scoped read, the structural patch, and the per-block text edits (written through page/block-text-write). Audience-agnostic — the agent-facing tools over it are page/annotations/agent-access.",
} satisfies ServerPluginDefinition;
