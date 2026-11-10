import { useRef } from "react";
import type { RowFocus } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { pageData } from "@plugins/page/plugins/editor/core";
import {
  useCaretEscape,
  useVoidCaret,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import { PageReferenceRow } from "@plugins/page/plugins/page-reference/web";
import { isPageCard } from "../internal/page-card";

/**
 * A sub-page rendered inline in its parent's content flow: icon + title, click
 * to open. Its own content lives under a different `page_id`, so this row is a
 * LEAF of the forest the editor reduces over.
 *
 * It is a *void* block — it owns no editable content. Like every other void
 * block it goes through `useVoidCaret`, which registers a focus handle so the
 * editor's focus system can land on it (`navigate()` skips blocks with no
 * handle, and selection / drag read from the same order). That handle carries
 * ONLY `focus`: no `truncateAt`, no
 * `appendRunsAtEnd`, no `focusOffset`. Those are the text-surgery seams a bound
 * text editor exposes, and their absence is what makes it structurally
 * impossible for Enter (split) or Backspace (merge) to ORIGINATE in a page row
 * — the hazard the reducer's guards then backstop.
 */
export function SubPageBlock({ block, isFocused, editor }: BlockRendererProps) {
  // The capability to focus the row, never the row's node: `Row` synthesizes its
  // own control and moves it the moment the row carries `actions`, so there is
  // no node here worth holding.
  const focusRef = useRef<RowFocus>(null);

  // The whole void-block caret plumbing — register the focus handle, pull DOM
  // focus when the editor says the caret is here, report focus back — is the
  // editor's, and it takes the row's focus *capability*, which is all this block
  // has to give. This block declares `caret: "renderer"` for exactly that
  // reason: the caret has to live on a control `Row` synthesizes and re-creates
  // as the row grows actions, which the editor's own caret host could never hold
  // on its behalf.
  const { onFocus } = useVoidCaret({
    blockId: block.id,
    isFocused,
    editor,
    focus: (opts) => focusRef.current?.focus({ reveal: opts?.scroll ?? false }),
  });

  // "The caret can always leave a void block" is the EDITOR's invariant, spelled
  // once — `useCaretEscape`. What stays local is what only a sub-page can
  // decide: Enter/Space fall through to the row's native button activation (open
  // the page), and Backspace is deliberately NOT handled, because deleting a
  // sub-page destroys a whole content partition — every block under another
  // `page_id` — which is far too much to hang off one keystroke.
  const onKeyDown = useCaretEscape(editor);

  // The row itself — icon, title, the page kind's decoration, trailing facts,
  // actions — is THE page-reference row, shared with the link-to-page block so
  // a page looks the same wherever it is referenced. Expanded, a decorated page
  // is a card (`isPageCard`) whose frame paints the wash, so the row drops its
  // own fill.
  return (
    <Inset x="md" y="xs">
      <PageReferenceRow
        pageId={block.id}
        page={pageData(block)}
        // The editor's caret being on this block IS `Row`'s `selected`.
        selected={isFocused}
        inCard={isPageCard(block)}
        focusRef={focusRef}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      />
    </Inset>
  );
}
