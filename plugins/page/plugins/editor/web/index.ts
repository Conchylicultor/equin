import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor as EditorSlots } from "./slots";
import { IdKinds } from "@plugins/ids/web";
import { blockIdKind } from "../core";

export {
  Editor,
  useIsFramedBlock,
  useFrameGeometry,
  useBlockDecorations,
  useBlockFeet,
} from "./slots";
export type {
  BlockContribution,
  BlockView,
  BlockFrameMeta,
  FrameCandidate,
  BlockDecoration,
  BlockDecorationSeat,
  FramePad,
  FrameGeometry,
} from "./slots";
// The pointer-inside-this-card signal a corner decoration reveals itself on.
// Both surfaces mount the provider; only the decorations subscribe.
export {
  FrameHoverProvider,
  useFrameHovered,
  useSetFrameHover,
} from "./internal/frame-hover";
export { MarkButton } from "./components/mark-button";
export type { MarkButtonProps } from "./components/mark-button";
export { useFormatToolbar } from "./internal/format-toolbar-context";
export type { FormatToolbarValue } from "./internal/format-toolbar-context";
export type {
  BlockAnchorProps,
  BlockChrome,
  BlockEditorAPI,
  BlockFootProps,
  BlockFrameProps,
  BlockRegion,
  BlockRegionProps,
  BlockRegions,
  BlockRendererProps,
  InsertAction,
  InsertActionContext,
  InsertActionRun,
} from "./types";
export { BlockEditor } from "./components/block-editor";
export type { BlockEditorHandle } from "./components/block-editor";
export {
  blockContentScope,
  blockRowIn,
  blockRowsIn,
} from "./internal/block-content-scope";
export type { CaretSurface, CaretSurfaceRef } from "./caret-surface";
export { caretFlightReportSink } from "./internal/caret-authority";
export type {
  CaretFlightAbortReason,
  CaretFlightAbortReport,
} from "./internal/caret-authority";
export { collabHydrationReportSink } from "./internal/hydration-report";
export type {
  CollabHydrationReason,
  CollabHydrationReport,
} from "./internal/hydration-report";
export { undoConflictReportSink } from "./internal/undo-conflict-report";
export type {
  UndoConflictReason,
  UndoConflictReport,
} from "./internal/undo-conflict-report";
export { PageContentColumn } from "./components/page-content-column";
export {
  BLOCK_INSET,
  BLOCK_INDENT,
  MARKER_GUTTER,
  // The frame box's own edges, derived from the surface-provided `inset` and
  // the three insets — exported for `ContainerBackdrop`, the ONE consumer that
  // paints that box. `BLOCK_GUTTER` stays unexported: a block contribution
  // still cannot compute a content edge, only apply one it was handed.
  frameBoxLeft,
  // The card's inner padding, for the surface that has to RESERVE it: the
  // read-only renderer, whose nesting is real wrappers, so its rows cannot be
  // handed a reserve the way the editor's grid rows are.
  FRAME_PAD_X,
  FRAME_PAD_Y,
} from "./internal/page-column";
export { BlockTextRenderer } from "./components/block-text-renderer";
// `BlockTextEditor` is deliberately NOT exported: a text-bearing block type
// never renders the editor itself, it declares `chrome` and lets the shared
// renderer place it. Removing the export deletes the roll-your-own-text-
// component affordance outright (prompt was its only external consumer).
export { TextBlockLayout } from "./components/text-block-layout";
export type { TextBlockLayoutProps } from "./components/text-block-layout";
export { useBlockEditor, useEditorScope } from "./block-editor-context";
export type { EditorScope } from "./block-editor-context";
// Imperative block selection, for a block that reveals ANOTHER block — the map
// block selecting the place whose pin was clicked. `null` outside a selection
// layer (a read-only surface).
export { useSelectionControl } from "./selection-control";
export type { SelectionControl } from "./selection-control";
// `BlockCaretHost` is deliberately NOT exported: it is what the editor mounts
// around a `caret: "editor"` block's row, and a block that could mount one for
// itself could equally forget to — which is the whole class of bug the `caret`
// registration field exists to close. A block declares where its caret lives; it
// never builds the box.
export {
  useVoidCaret,
  useCaretEscape,
  useBlockActivate,
} from "./components/void-caret";
export type { VoidCaret, VoidCaretOptions } from "./components/void-caret";
// The ONE plain-text editing surface a page block may own. A block that holds
// source rather than prose (code, an equation) declares its draft here instead
// of hand-rolling a textarea: recording is synchronous on the keystroke, the row
// write is debounced and records nothing, and the void-caret registration is
// made from inside so a caller cannot forget it.
export { useBlockPlainText, BlockTextArea } from "./components/block-text-area";
// The page's own markdown dialect bound to the live registry, for a block that
// edits its markdown SOURCE in place (the table's source mode).
export { usePageMarkdownContext } from "./internal/page-markdown-context";
export type {
  BlockPlainText,
  BlockPlainTextControl,
  BlockPlainTextOptions,
  BlockPlainTextProps,
  BlockTextAreaProps,
  BlockTextSelection,
} from "./components/block-text-area";
export {
  useInsertableBlocks,
  useGroupedInsertableBlocks,
  flattenSections,
  filterInsertEntries,
  BlockTypeList,
} from "./components/block-type-list";
export type {
  BlockSection,
  InsertEntry,
  InsertSection,
} from "./components/block-type-list";
export {
  registerBlockTextExtension,
  registerBlockTextExtensionSource,
  blockTextTokenExtension,
  getBlockTextExtensions,
  blockTextRenderableExtensions,
  colorCssValue,
} from "./internal/block-text-extensions";
export { registerBlockPasteHandler } from "./internal/block-paste-handlers";
// The one read of a transfer's text, exported so a contributed block-text
// plugin classifying its own paste/drop uses the same `text/plain` →
// `text/uri-list` fallback Lexical's own insert does (url-paste's bare-URL
// gate would otherwise miss a link dragged out of another tab).
export { readTransferText } from "./internal/transfer";
export type { BlockPasteHandler } from "./internal/block-paste-handlers";
export { OPEN_LINK_POPOVER_COMMAND } from "./internal/link-command";
export { isValidLinkUrl, normalizeLinkUrl } from "./internal/link-url";
export { $setLinkText } from "./internal/link-text";
export type {
  BlockTextExtension,
  BlockTextTokenExtension,
  BlockTextPluginProps,
} from "./internal/block-text-extensions";
export { usePageOptions, PageOptionsList } from "./components/page-options";
export type { PageOption, PageOptionsResult } from "./components/page-options";
export { PageIcon } from "./components/page-icon";
export type { PageIconProps } from "./components/page-icon";

export default {
  description: "Block-based document editor component and slot system.",
  slots: EditorSlots,
  contributions: [IdKinds.Kind({ kind: blockIdKind })],
} satisfies PluginDefinition;
