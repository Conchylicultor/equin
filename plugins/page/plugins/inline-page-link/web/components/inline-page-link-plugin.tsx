import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  foldResource,
  matchResource,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  CaretTriggerMenu,
  useCaretMenu,
  useCaretQuery,
} from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
import {
  usePageOptions,
  PageOptionsList,
  type BlockTextPluginProps,
  type PageOption,
} from "@plugins/page/plugins/editor/web";
import { $createPageLinkInlineNode } from "./page-link-inline-node";
import { createLinkedPage } from "../internal/create-linked-page";

const NO_OPTIONS: readonly PageOption[] = [];

/**
 * Inline, Notion-style `[[` page-mention typeahead, built on the shared
 * caret-trigger primitive: open-state + query are DERIVED from the live editor
 * text (never a latch — see the primitive's CLAUDE.md); arrows/Enter navigate,
 * Esc / outside-press dismiss. Since `[[` is mid-line the menu renders through
 * `CaretTriggerMenu`, caret-anchored.
 *
 * On select, the `[[query` is replaced with an inline page-link node (+ a trailing
 * space); for "Create '<query>'" a new page is created first. The node persists as
 * a `[[page:<pageId>]]` token via the block-text extension's serializer. Removing the
 * `[[query` text inside the same `update()` re-derives "no trigger", so the menu
 * closes by derivation — no explicit close.
 */
export function InlinePageLinkPlugin(_: BlockTextPluginProps) {
  const [lexicalEditor] = useLexicalComposerContext();
  const fetchEndpoint = useFetchEndpoint();

  function insertLink(pageId: string) {
    lexicalEditor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
      const node = sel.anchor.getNode();
      if (!$isTextNode(node)) return;
      const full = node.getTextContent();
      const caretOffset = sel.anchor.offset;
      const idx = full.slice(0, caretOffset).lastIndexOf("[[");
      if (idx === -1) return;
      const head = full.slice(0, idx);
      const tail = full.slice(caretOffset);
      node.setTextContent(head);
      const link = $createPageLinkInlineNode(pageId);
      const space = $createTextNode(" ");
      node.insertAfter(link);
      link.insertAfter(space);
      if (tail) space.insertAfter($createTextNode(tail));
      // Caret immediately after the inserted space.
      space.select(1, 1);
    });
  }

  function handleSelect(option: PageOption) {
    if (option.kind === "page") {
      insertLink(option.page.id);
    } else {
      void createLinkedPage(fetchEndpoint, option.title).then((id) =>
        insertLink(id),
      );
    }
  }

  const caret = useCaretQuery({
    id: "page-link",
    trigger: "[[",
    isQueryValid: (q) => !/[[\]\n]/.test(q),
  });

  const pageOptionsResult = usePageOptions(caret.query, { allowCreate: true });
  // Settled options drive keyboard nav; [] while loading or failed is safe —
  // itemCount is 0 (not interactive) then, and the menu shows a spinner or the
  // failure, not "No pages found".
  const options = foldResource(pageOptionsResult, {
    loading: () => NO_OPTIONS,
    error: () => NO_OPTIONS,
    ready: (ready) => ready,
  });

  const { surfaceOpen, activeIndex, setActiveIndex, commit } = useCaretMenu(
    caret,
    {
      itemCount: options.length,
      onCommit: (i) => handleSelect(options[i]!),
    },
  );

  // Keyboard (Enter) and mouse both commit through `onCommit` via the menu's
  // `commit` (pointerdown-timed + `editor.update`-wrapped), so a click behaves
  // exactly like Enter (see `useCaretMenu`).
  return (
    <CaretTriggerMenu
      caret={caret}
      open={surfaceOpen}
      width="lg"
      padding="xs"
      maxHeight="md"
    >
      {matchResource(pageOptionsResult, {
        loading: () => <Loading variant="rows" />,
        ready: (ready) => (
          <PageOptionsList
            options={ready}
            activeIndex={activeIndex}
            onCommit={commit}
            onHoverIndex={setActiveIndex}
          />
        ),
      })}
    </CaretTriggerMenu>
  );
}
