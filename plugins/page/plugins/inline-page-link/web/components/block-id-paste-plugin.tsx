import { useEffect } from "react";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  PASTE_COMMAND,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import {
  readTransferText,
  useBlockEditor,
  type BlockTextPluginProps,
} from "@plugins/page/plugins/editor/web";
import { pageLinkBlock } from "@plugins/page/plugins/page-link/core";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { $createPageLinkInlineNode } from "./page-link-inline-node";

/**
 * Pasting a bare block id (`block-<uuid>`, any recognised form) makes it a
 * reference to that page rather than literal text:
 *
 * - into an EMPTY block, the block itself becomes a `page-link` block — the
 *   same outcome as Turn into → Link to page, then picking the page;
 * - anywhere else, the id becomes an inline `[[page]]` chip at the caret (over
 *   a selected range, it replaces the range — as pasting any text would).
 *
 * The id is recognised by `blockIdKind.is` — the one recognition the id kind
 * declares — so this never re-parses the id's shape itself. A block id is
 * opaque; whether it names a page is the chip's / link block's own read (both
 * render "not found" for an id with no page behind it).
 *
 * "Empty" reads the LIVE root text, not the row's `data.text` copy, which trails
 * the editor (same rule as `url-paste`), and requires a hydrated root.
 *
 * The inline insert is its own undo entry ("Paste page link") through
 * `recordDocEdit`, which runs it one microtask later — outside the command's
 * `editor.update()`, so the discrete update commits inside the recording scope.
 * The conversion is `editor.convertTo`, which records itself.
 */
export function BlockIdPastePlugin({ block, editor }: BlockTextPluginProps) {
  const [lexical] = useLexicalComposerContext();
  const { recordDocEdit } = useBlockEditor();

  const insertChip = useEventCallback((pageId: string) => {
    recordDocEdit(block.id, "Paste page link", () => {
      let ran = false;
      lexical.update(
        () => {
          ran = true;
          const sel = $getSelection();
          // The gate saw a RangeSelection one microtask ago; nothing in between
          // moves the selection out of this editor.
          if (!$isRangeSelection(sel)) {
            throw new Error(
              "inline-page-link paste: the caret the id was gated on is gone — no RangeSelection to insert at",
            );
          }
          sel.insertNodes([$createPageLinkInlineNode(pageId)]);
        },
        { discrete: true },
      );
      if (!ran) {
        throw new Error(
          "inline-page-link paste: the discrete update was enqueued, not committed — it must run outside editor.update()",
        );
      }
    });
  });

  useEffect(
    () =>
      lexical.registerCommand<ClipboardEvent>(
        PASTE_COMMAND,
        (event) => {
          const data = event.clipboardData;
          const text = data ? readTransferText(data).trim() : "";
          if (!blockIdKind.is(text)) return false;
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return false;
          // Never a link to the block being typed in.
          if (text === block.id) return false;
          event.preventDefault();
          const root = $getRoot();
          if (
            root.getChildrenSize() > 0 &&
            root.getTextContent().trim() === ""
          ) {
            // Collapsed: the link names the page; its content is one click away.
            editor.convertTo(
              pageLinkBlock.type,
              { pageId: text },
              { expanded: false },
            );
          } else {
            insertChip(text);
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [lexical, editor, block.id, insertChip],
  );

  return null;
}
