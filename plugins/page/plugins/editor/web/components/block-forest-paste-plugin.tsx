import { useEffect, useMemo } from "react";
import { COMMAND_PRIORITY_NORMAL, PASTE_COMMAND } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { clipboardEventOf } from "@plugins/primitives/plugins/text-editor/plugins/clipboard-event/core";
import {
  parseMarkdownToForest,
  type ForestGranularity,
  type SerializedBlock,
} from "../../core";
import { useBlockEditor } from "../block-editor-context";
import { Editor } from "../slots";
import {
  $linearSelectionSpan,
  blockTextProtectedSpans,
  serializeBlockRuns,
  type BlockTextPluginProps,
} from "../internal/block-text-extensions";
import { runsWithoutSpan } from "../internal/runs-without-span";
import { resolvePastedBlock } from "../internal/block-paste-handlers";
import {
  BLOCKS_MIME,
  decideTransfer,
  decodeBlocksPayload,
  readTransferText,
} from "../internal/transfer";

/**
 * Invisible Lexical plugin that makes a caret-in-block paste honor the block
 * clipboard, so it matches the block-selection-mode container paste
 * (`block-editor.tsx`). Without it, Lexical's default RichText paste dumps a
 * copied forest's `text/plain` fallback into ONE block's Y.Doc, breaking
 * one-paragraph-per-block. On `PASTE_COMMAND` it resolves the clipboard shape via
 * `decideTransfer` — the same classifier the container's paste and DROP doors
 * run — with `inline: true`, because a caret IS an insertion point:
 *  - a pasted FILE → `return false` (BlockPastePlugin owns it; the early bail
 *    makes registration order irrelevant);
 *  - text with a newline (parsed as markdown) → `preventDefault` and SPLICE
 *    the forest in at the selection: the text before it keeps its line and
 *    absorbs a leading paragraph, the text after it lands at the end of the
 *    pasted content (`planSplice`). A range selection is replaced — its span
 *    is cut from the runs the splice reads;
 *  - a `BLOCKS_MIME` forest → the same splice at the granularity its payload
 *    states: a block copied WHOLE lands as whole lines after the caret's line
 *    (or in place of an empty one), never merged into its text — which is what
 *    keeps a bare-caret Cmd+C, Cmd+V a two-keystroke duplicate;
 *  - newline-free text → `return false` (native inline paste is left
 *    untouched: text with no line in it carries no structure to splice).
 *
 * The splice is what makes `The plugin system⏎` pasted into an empty line fill
 * THAT line rather than land in a new block below an empty one — and `a⏎b`
 * pasted at `foo|bar` read `fooa`, `bbar`, with the caret after `b`.
 *
 * Registered at `COMMAND_PRIORITY_NORMAL` (like BlockPastePlugin) so multi-line /
 * forest pastes beat the bare-URL handler (LOW) and the default RichText paste
 * (LOW). An empty parsed forest (whitespace-only multi-line text) declines
 * without `preventDefault`, so the event is never swallowed for nothing.
 */
export function BlockForestPastePlugin({ block }: BlockTextPluginProps) {
  const [lexical] = useLexicalComposerContext();
  const { splice } = useBlockEditor();
  const contributions = Editor.Block.useContributions();
  const handles = useMemo(
    () => contributions.map((c) => c.block),
    [contributions],
  );

  useEffect(() => {
    return lexical.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboard = clipboardEventOf(event)?.clipboardData ?? null;
        if (!clipboard) return false;
        const decision = decideTransfer({
          isFile: resolvePastedBlock(clipboard) !== null,
          blocksJson: clipboard.getData(BLOCKS_MIME),
          text: readTransferText(clipboard),
          inline: true,
        });
        if (decision.kind === "file" || decision.kind === "inline")
          return false;

        let forest: SerializedBlock[];
        // External text is TEXT, spliced into the line; a copied block forest
        // says what it was copied as (whole blocks, today, always).
        let granularity: ForestGranularity = "text";
        if (decision.kind === "forest") {
          const payload = decodeBlocksPayload(decision.json);
          // Mirror the container handler's tolerance: a malformed payload is
          // not our paste — fall through to the default.
          if (!payload.ok) return false;
          forest = payload.forest;
          granularity = payload.granularity;
        } else {
          forest = parseMarkdownToForest(decision.text, {
            handles,
            protectedSpans: blockTextProtectedSpans(),
            // Foreign markdown: a blank line separates paragraphs, exactly as
            // for the container paste (`block-editor.tsx`).
            blankLines: "separator",
            // Parse-side, so nothing here reads it — stated because the record
            // is ONE dialect, as every serialize site states `blankLines`.
            emptyBlocks: "blank-line",
            softBreaks: "newline",
          });
        }
        // Empty/unparseable forest (e.g. whitespace-only multi-line) → let the
        // native paste run; never swallow the event for nothing.
        if (!Array.isArray(forest) || forest.length === 0) return false;

        // The insertion point, read off the LIVE editor (what is on screen now,
        // uncommitted keystrokes included — split's basis): the selection's
        // span, cut out of the runs, and its start. A handler inside a paste
        // command runs inside an editor update, so the selection is current.
        const span = $linearSelectionSpan();
        // No range selection in this editor: nothing says where the paste
        // lands, so it is not ours — the native paste runs.
        if (span === null) return false;
        event.preventDefault();
        splice({
          blockId: block.id,
          position: span.from,
          runs: runsWithoutSpan(
            serializeBlockRuns(lexical),
            span.from,
            span.to,
          ),
          blocks: forest,
          granularity,
        });
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [lexical, block, splice, handles]);

  return null;
}
