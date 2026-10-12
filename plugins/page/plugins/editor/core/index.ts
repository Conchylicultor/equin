export {
  BlockSchema,
  PageRowSchema,
  PageDataSchema,
  PageKindSchema,
  pageKindOf,
  samePageKind,
  withPageKind,
  PageCoverSchema,
  PAGE_BLOCK_TYPE,
  PAGES_TRASH_SOURCE,
  PAGE_BLOCKS_TRASH_SOURCE,
  pageData,
  pageBlockHandle,
  pageBlockMarkdown,
  pageBlockAuthor,
} from "./schemas";
export type {
  Block,
  PageRow,
  PageData,
  PageKind,
  PageCover,
  BlockData,
} from "./schemas";

export {
  pagesTree,
  pageBlocks,
  blockLocations,
  BlockLocationSchema,
} from "./resources";
export type { BlockLocation } from "./resources";

export {
  listPages,
  listBlocks,
  getBlockPage,
  BlockPageSchema,
  createBlock,
  updateBlock,
  deleteBlock,
  moveBlock,
  moveBlocks,
  turnIntoPage,
  setPageKind,
  applyBlockOpEndpoint,
  patchBlocks,
  CreateBlockBodySchema,
  UpdateBlockBodySchema,
  MoveBlockBodySchema,
  TurnIntoPageBodySchema,
  SetPageKindBodySchema,
} from "./endpoints";
export type {
  BlockPage,
  CreateBlockBody,
  UpdateBlockBody,
  MoveBlockBody,
  TurnIntoPageBody,
  SetPageKindBody,
} from "./endpoints";

export {
  BlockOpSchema,
  applyBlockOp,
  canIndent,
  canOutdent,
  childrenOf,
  inDocumentOrder,
  toNodes,
  opNamedIds,
  pasteAnchorId,
  blockSelectionRoots,
  withContainersSelected,
  prevVisibleLine,
  nextVisibleLine,
  visibleChildRule,
  visibleChildrenOf,
  collapsedAnchorAbove,
  textOf,
  runsOfNode,
  withRuns,
  blockOpContextOf,
  planSplice,
} from "./block-ops";
export type {
  BlockOp,
  BlockOpContext,
  BlockNode,
  IsAnchor,
  SpliceCaret,
  ForestGranularity,
} from "./block-ops";

export {
  BlockPatchSchema,
  BlockFieldChangesSchema,
  changedFields,
  dataEqual,
  namesField,
  diffBlocks,
  writtenIds,
  patchesFromDiff,
  isEmptyPatch,
} from "./block-diff";
export type {
  BlockPatch,
  BlockUpdate,
  BlockFieldChanges,
  BlockDiff,
} from "./block-diff";

export {
  MARK_ORDER,
  COLOR_TOKENS,
  sortMarks,
  runsOf,
  plainOf,
  runsLength,
  splitRuns,
  mergeRuns,
  runsEqual,
  coalesce,
  TextRunSchema,
  RichTextSchema,
} from "./rich-text";
export type { Mark, ColorToken, TextRun, RichText } from "./rich-text";

export {
  INLINE_SYNTAXES,
  matchInlineFormat,
  parseInlineMarkdown,
  serializeInlineMarkdown,
} from "./inline-markdown";
export type {
  InlineSyntax,
  InlineFormatMatch,
  InlineFormatContext,
  MarkdownSpan,
  SoftBreaks,
} from "./inline-markdown";

export {
  $appendRuns,
  colorCssValue,
  marksOfTextNode,
  runsToLexical,
  serializeBlockRuns,
  tokenOf,
} from "./runs-lexical";

export { $spliceRunsInto } from "./runs-splice";

export { normalizeSpan, joinAroundSpan, stepTextOffset } from "./text-span";
export type { SpanPoint, SpanLines, SpanSelection } from "./text-span";

export { runsToXmlText, xmlTextToRuns, xmlTextContentLength } from "./runs-yjs";

export { blockIdKind, newBlockId } from "./block-id";

export {
  SerializedBlockSchema,
  IdentifiedBlockSchema,
  withMintedIds,
  withPasteIds,
  pageSourcesOf,
} from "./serialized-block";
export type {
  SerializedBlock,
  IdentifiedBlock,
  PageSource,
} from "./serialized-block";

export { rankWindow, planForestInsert } from "./block-forest";

export { semanticsAttrs } from "./block-semantics";
export type { BlockSemantics, BlockSemanticsAttrs } from "./block-semantics";

export {
  blockAuthorOf,
  conversionPrefixesOf,
  defineBlock,
} from "./define-block";
export type {
  BlockAudience,
  BlockAuthor,
  BlockHandle,
  BlockTextVariant,
} from "./define-block";

export { hasTextKey, rowDataOf } from "./row-data";
export type { RowData } from "./row-data";

export {
  serializeForestToMarkdown,
  parseMarkdownToForest,
  defaultTextHandle,
  dropBlankLinesBesideTags,
  formatTagLine,
  parseTagLine,
  markdownLineClaim,
  markdownParseTagNames,
  markdownTagIsIdentified,
  markdownTagNameOf,
  markdownTagNamesAuthoredBy,
} from "./markdown";
export type {
  BlockMarkdown,
  BlockTag,
  BlockTagBody,
  BlockTagSpelling,
  MarkdownContext,
  MarkdownNode,
  MdSerializeCtx,
  MdParseCtx,
  TagLine,
} from "./markdown";

export { textDataSchema, textBlockSchema } from "./text-data";
export type { TextData, TextBearingSchema } from "./text-data";
