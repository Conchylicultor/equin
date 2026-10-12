import { useRef } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Row,
  type RowFocus,
} from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { pageData } from "@plugins/page/plugins/editor/core";
import {
  PageIcon,
  useCaretEscape,
  useVoidCaret,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import {
  PageReferenceTrailing,
  usePageNavigation,
  usePageReferenceActions,
  usePageReferenceDecoration,
} from "@plugins/page/plugins/page-reference/web";
import { isPageCard } from "../internal/page-card";

/**
 * The row's activation where the host declared no navigation: it still has to
 * be a `<button>` (the editor's caret lands on its control through `focusRef`),
 * it just opens nothing.
 */
const INERT = (): void => undefined;

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
  const nav = usePageNavigation();
  // The row's own click opens in place; everything else the user can do with the
  // referenced page (open it beside this one, …) is a contributed action.
  const actions = usePageReferenceActions(block.id);
  // The capability to focus the row, never the row's node: `Row` synthesizes its
  // own control and moves it the moment the row carries `actions` (which this
  // one does), so there is no node here worth holding.
  const focusRef = useRef<RowFocus>(null);
  const page = pageData(block);
  const { title, icon } = page;
  // What KIND of page this is — an agent-authored one, say — is another
  // plugin's answer, read off the page's own data: a tint for the row and
  // perhaps a chip naming something about it. This row knows no kind.
  const decoration = usePageReferenceDecoration(block.id, page);
  // Expanded, a decorated page is a card (`isPageCard`): the frame paints the
  // wash over this row and the content below it, so the row gives up its own
  // FILL — washed twice, the title line would read as a second, darker box. It
  // keeps the rest of the tint: the `--scrim` a pinned action cluster dissolves
  // into is the same wash either way (`cn` merges the fill away, nothing else).
  const tint =
    decoration && isPageCard(block)
      ? cn(decoration.tint, "bg-transparent")
      : decoration?.tint;

  // The whole void-block caret plumbing — register the focus handle, pull DOM
  // focus when the editor says the caret is here, report focus back — is the
  // editor's, and it takes the row's focus *capability*, which is all this block
  // has to give. This block declares `caret: "renderer"` for exactly that
  // reason: the caret has to live on a control `Row` synthesizes and re-creates
  // as the row grows actions, which the editor's own caret host could never hold
  // on its behalf. The cue is `Row`'s too (see `selected` below).
  const { onFocus } = useVoidCaret({
    blockId: block.id,
    isFocused,
    editor,
    focus: () => focusRef.current?.focus(),
  });

  // "The caret can always leave a void block" is the EDITOR's invariant, not this
  // block's promise, so it is spelled once — `useCaretEscape` — rather than
  // hand-copied here. What stays local is what only a sub-page can decide:
  // Enter/Space fall through to the row's native button activation (open the
  // page), and Backspace is deliberately NOT handled, because deleting a
  // sub-page destroys a whole content partition — every block under another
  // `page_id` — which is far too much to hang off one keystroke. Removing one
  // stays an explicit menu action.
  const onKeyDown = useCaretEscape(editor);

  // A decoration's chip is information, so it reads at rest; the reference
  // actions are something you reach for, so they still appear on hover. Two
  // clusters, then — the data-view group header's count + fold toggle shape: the
  // row's own cluster turns persistent and carries the chip, and the actions
  // ride an inline `RowActions` beside it, revealed off the row's hover group
  // like before. Inline rather than pinned is the price: the pinned cluster
  // overlays the row's trailing edge, which is exactly where the chip sits.
  // Rows with no chip keep the plain pinned cluster, untouched.
  const chip = decoration?.chip ?? null;
  const trailing =
    chip === null ? (
      actions
    ) : (
      <Stack direction="row" gap="xs" align="center">
        {chip}
        {actions === null ? null : (
          <RowActions pin={null}>{actions}</RowActions>
        )}
      </Stack>
    );

  return (
    <Inset x="md" y="xs">
      <Row
        focusRef={focusRef}
        // The editor's caret being on this block IS `Row`'s `selected` — this is
        // the current row. The bespoke ring that used to live here was a SECOND
        // focus indicator, drawn on the row box while the browser drew its own
        // on the inner control; `Row` now owns the focus ring, and this owns
        // "current": `selected` resolves to `bg-selected` (default = the
        // accent), the tint the editor's own caret host paints — so the two
        // void arms, the row and the host's box, say "the caret is here" in
        // one voice.
        selected={isFocused}
        // The decoration's wash — dropped while the caret is here, because
        // `selected` and a tint are both a row BACKGROUND, and `Row` merges its
        // caller's class last: kept, the tint would erase the caret cue. Hover
        // still wins over it on its own (a `hover:` variant outranks a plain
        // utility), so the row answers the pointer exactly like any other.
        className={isFocused ? undefined : tint}
        // A link: ⌘/middle-click opens the page in a new browser tab, and
        // Enter/Space synthesize the plain click, which opens it in place.
        {...activationProps(nav?.open(block.id) ?? INERT)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        actions={trailing}
        actionsAlwaysVisible={chip !== null}
        icon={
          <Center as="span" className="text-muted-foreground size-4">
            <PageIcon icon={icon} className="size-4" />
          </Center>
        }
      >
        <Text className="font-medium underline-offset-2 hover:underline">
          {title || "Untitled"}
        </Text>
        {/* What other plugins say ABOUT the page (its tags, …), right after
            the title and always visible; the title truncates first. */}
        <PageReferenceTrailing pageId={block.id} />
      </Row>
    </Inset>
  );
}
