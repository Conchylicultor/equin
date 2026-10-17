import { useEffect, useMemo, useState } from "react";
import { $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  atWordBoundary,
  CaretTriggerMenu,
  useCaretMenu,
  useCaretQuery,
  useForcedCaretQuery,
} from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
import { useBlockEditor } from "../block-editor-context";
import { Editor } from "../slots";
import type { InsertAction, InsertActionRun } from "../types";
import {
  $linearCaretOffset,
  serializeBlockRuns,
} from "../internal/block-text-extensions";
import { runsWithoutSpan } from "../internal/runs-without-span";
import { flattenEntries, type InsertEntry } from "../internal/block-sections";
import {
  BlockTypeList,
  filterInsertEntries,
  useInsertMenuSections,
} from "./block-type-list";

const TRIGGER = "/";

/**
 * Unified, Notion-style block menu built on the shared caret-trigger primitive.
 * It opens EITHER of two ways, sharing ONE caret-anchored surface + one keyboard
 * model:
 *
 * - **`/` trigger** — typing `/` at a word boundary opens it; the text after the
 *   `/` filters it (`useCaretQuery`). `canOpen: atWordBoundary` keeps it from
 *   firing on `/` inside URLs (`http://`), dates (`06/15`), paths, or fractions;
 *   a `/` followed by a space is a literal slash.
 * - **Gutter `+` draft** — the gutter `+` inserts an empty paragraph below,
 *   focuses it, and flags it as the draft (`blockMenuDraftId`). This block's
 *   `useForcedCaretQuery` force-opens the same surface, filtered by the block's
 *   OWN text before the caret. Esc / outside-press clears the draft (keeping the
 *   block); the placeholder reads "Type to filter" while it is open.
 *
 * On commit the query span is stripped and the block is converted in place: the
 * `/` flow keeps the text around the slash; the draft flow drops the whole text
 * before the caret (it was pure filter, not content). Both go through the ONE
 * `convertStrippingText` primitive — the strip is a CONTENT-DOC edit (text has a
 * single owner), never a row payload the type write carries.
 *
 * The list also carries contributed `Editor.InsertAction`s, ranked among the
 * block types by the same filter. Committing one consumes the same span by the
 * same rule (`stripText`, the strip half alone) and then hands the line to the
 * action's `run` instead of converting it.
 */
export function BlockMenuPlugin({ blockId }: { blockId: string }) {
  const [lexicalEditor] = useLexicalComposerContext();
  const grouped = useInsertMenuSections(blockId);
  const flatAll = useMemo(() => flattenEntries(grouped), [grouped]);
  const {
    blockMenuDraftId,
    clearBlockMenu,
    convertStrippingText,
    stripText,
    makeBlockAPI,
  } = useBlockEditor();
  const active = blockMenuDraftId === blockId;
  // A newline ends the query; any space means the user typed a literal `/ …`
  // (not a command) — Notion dismisses the menu the moment a space follows.
  const isQueryValid = (q: string) => !/[\n ]/.test(q);

  const caret = useCaretQuery({
    id: "slash",
    trigger: TRIGGER,
    canOpen: atWordBoundary,
    isQueryValid,
  });
  const forced = useForcedCaretQuery({
    id: "block-draft",
    active,
    isQueryValid,
    onDismiss: () => clearBlockMenu(blockId),
  });

  const useForced = active;
  const menu = useForced ? forced : caret;
  // While filtering, collapse to a single flat label-less section (headers make
  // no sense over a relevance-ranked result); with no query, show the grouped
  // sections. `flat` is the keyboard nav index space (over selectable rows only),
  // matching what `BlockTypeList` renders.
  const sections = useMemo(
    () =>
      menu.query
        ? [{ entries: filterInsertEntries(flatAll, menu.query) }]
        : grouped,
    [menu.query, flatAll, grouped],
  );
  const flat = useMemo(() => flattenEntries(sections), [sections]);
  // Every contributed action's runner, bound by `InsertActionBinding` — its
  // `useRun` is a hook, and the set of actions can grow as plugin tiers load,
  // so each is called in a component of its own, never in a loop here.
  const actions = Editor.InsertAction.useContributions();
  const [runners] = useState(() => new Map<string, InsertActionRun>());

  function handleSelect(entry: InsertEntry) {
    // Resolve the consumed span as LINEAR offsets — the stored-runs plain-text
    // basis the whole content-surgery seam speaks (same as split `position`).
    //   - slash: `[the `/`, the caret)`, so the text AROUND the slash survives.
    //   - draft: `[block start, the caret)` — every character before the caret
    //     was filter text the user never meant as content.
    // Read the committed state: this runs inside the caret menu's own
    // `editor.update()` (both the Enter command and the pointer commit), where
    // nothing has been mutated yet.
    let found = false;
    let from = 0;
    let to = 0;
    lexicalEditor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
      const caret = $linearCaretOffset();
      if (caret === null) return;
      if (useForced) {
        // An empty draft block has no text node at all — `from === to === 0`
        // strips nothing and the conversion proceeds, which is the point.
        found = true;
        to = caret;
        return;
      }
      const node = sel.anchor.getNode();
      if (!$isTextNode(node)) return;
      const idx = node
        .getTextContent()
        .slice(0, sel.anchor.offset)
        .lastIndexOf(TRIGGER);
      if (idx === -1) return;
      found = true;
      // Within ONE text node linear offsets advance 1:1 with node offsets, so
      // the node-relative distance back to the `/` is also the linear distance.
      from = caret - (sel.anchor.offset - idx);
      to = caret;
    });
    if (!found) return;

    if (entry.kind === "block") {
      convertStrippingText({
        blockId,
        from,
        to,
        type: entry.block.type,
        // The block keeps its id, so it keeps its content doc: seed only the
        // target type's NON-text defaults and let its text come along untouched.
        data: entry.block.emptyRowData(),
      });
    } else {
      // Same strip, same moment — the action then owns what happens to the
      // line. The action is handed the line's text WITHOUT the query, cut here
      // from the live runs (same linear basis as `from`/`to`): the strip is a
      // nested update that lands only after this commit's own, so nothing the
      // action could read would say it yet — and an action that replaces the
      // line must carry the rest of it over, never drop it.
      const text = runsWithoutSpan(serializeBlockRuns(lexicalEditor), from, to);
      const run = runners.get(entry.action.id);
      if (!run) {
        throw new Error(
          `insert action "${entry.action.id}" committed with no bound runner`,
        );
      }
      stripText({ blockId, from, to });
      run({ blockId, editor: makeBlockAPI(blockId), text });
    }
    if (useForced) clearBlockMenu(blockId);
  }

  const { surfaceOpen, activeIndex, setActiveIndex, commit } = useCaretMenu(
    menu,
    {
      itemCount: flat.length,
      onCommit: (i) => handleSelect(flat[i]!),
      surfaceWhen: "interactive",
    },
  );

  // Both keyboard (Enter) and mouse commit through the SAME `onCommit` — the
  // menu's `commit` runs it on pointerdown and inside an `editor.update()`, so a
  // click and Enter are the same operation (see `useCaretMenu`).
  return (
    <>
      {actions.map((action) => (
        <InsertActionBinding
          key={action.id}
          action={action}
          runners={runners}
        />
      ))}
      <CaretTriggerMenu
        caret={menu}
        open={surfaceOpen}
        width="sm"
        padding="xs"
        maxHeight="lg"
      >
        <BlockTypeList
          sections={sections}
          activeIndex={activeIndex}
          onCommit={commit}
          onHoverIndex={setActiveIndex}
        />
      </CaretTriggerMenu>
    </>
  );
}

/**
 * Calls one insert action's `useRun` — inside the editor, so the runner reads
 * the host's context — and keeps its latest runner in `runners` under the
 * action's id, for the menu to run on commit.
 */
function InsertActionBinding({
  action,
  runners,
}: {
  action: InsertAction;
  runners: Map<string, InsertActionRun>;
}) {
  const run = action.useRun();
  useEffect(() => {
    runners.set(action.id, run);
    return () => {
      runners.delete(action.id);
    };
  }, [runners, action.id, run]);
  return null;
}
