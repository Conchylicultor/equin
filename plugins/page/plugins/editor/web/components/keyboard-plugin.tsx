import { useEffect, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  SELECT_ALL_COMMAND,
  type LexicalCommand,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { crossCaret } from "@plugins/primitives/plugins/text-editor/plugins/caret-motion/web";
import type { BlockEditorAPI } from "../types";
import { Editor } from "../slots";
import { useBlockEditor } from "../block-editor-context";
import { useSelectionControl } from "../selection-control";
import { serializeBlockRuns } from "../internal/block-text-extensions";
import {
  $placeCaretAtOffset,
  readCaretContext,
  SKIP_SCROLL_TAG,
  type CaretContext,
} from "../internal/caret-geometry";
import {
  $scanMarkSpan,
  removeMarkSpan,
} from "../internal/inline-format-surgery";
import { registerMarkArrival } from "../internal/mark-arrival";
import {
  markStep,
  readMarkDepth,
  registerMarkDepth,
} from "../internal/mark-depth";
import { toNodes } from "../internal/optimistic-block-ops";
import { scopeNodes } from "../internal/zoom-scope";
import {
  resolveKeystroke,
  type KeyIntent,
  type KeystrokeKey,
} from "../internal/keystroke-intent";

/**
 * Translates every caret-affecting keystroke into a structural op or a cross-block
 * caret move. The plugin is intentionally thin: it reads the caret geometry, hands
 * `(key, caret, block context)` to the single `resolveKeystroke` intent step, and
 * executes the returned intent against the block API. All the decisions (split
 * asChild, merge-vs-outdent, indent/outdent guards, when an arrow crosses blocks)
 * live in `resolveKeystroke`, not here.
 */
export function KeyboardPlugin({
  blockId,
  editor,
}: {
  blockId: string;
  editor: BlockEditorAPI;
}) {
  const [lexicalEditor] = useLexicalComposerContext();
  const { rowsRef, unwrapBlock, makeBlockAPI, recordDocEdit, scope } =
    useBlockEditor();
  const scopeRootId = scope.rootId;
  const recordDocEditRef = useLatestRef(recordDocEdit);
  const unwrapRef = useRef(unwrapBlock);
  unwrapRef.current = unwrapBlock;
  const makeBlockAPIRef = useRef(makeBlockAPI);
  makeBlockAPIRef.current = makeBlockAPI;
  // The block-type registry: every block's static handle config (incl. the edit
  // policy and split-into-child flag). Resolved here, not prop-drilled.
  const contributions = Editor.Block.useContributions();
  const contributionsRef = useRef(contributions);
  contributionsRef.current = contributions;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const selection = useSelectionControl();
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const blockIdRef = useRef(blockId);
  blockIdRef.current = blockId;

  useEffect(() => {
    function execute(
      intent: KeyIntent,
      event: KeyboardEvent,
      caret: CaretContext,
    ): boolean {
      const api = editorRef.current;
      switch (intent.type) {
        case "passthrough":
          return false;
        case "noop":
          // Ours, but nothing to do — consume the event (e.g. Tab at a boundary
          // must not move focus or insert a tab character).
          event.preventDefault();
          return true;
        case "split": {
          event.preventDefault();
          // Serialize the live runs so the reducer splits the authoritative
          // (possibly not-yet-autosaved) content.
          const runs = serializeBlockRuns(lexicalEditor);
          api.split(intent.position, {
            asChild: intent.asChild,
            childType: intent.childType,
            siblingType: intent.siblingType,
            tailData: intent.tailData,
            runs,
          });
          return true;
        }
        case "convertTo": {
          event.preventDefault();
          // Reset this block to a plain type (children untouched). This ladder
          // rung strips NOTHING — it removes a marker glyph the block never
          // stored as text — so it carries no text at all: the block keeps its
          // id, hence its content doc, and `convertTo` carries the row's `text`
          // projection across on its own. An unregistered `intent.to` seeds an
          // empty payload and the write boundary rejects the unknown type
          // loudly, as before.
          const target = contributionsRef.current.find(
            (c) => c.block.type === intent.to,
          )?.block;
          api.convertTo(intent.to, target?.emptyRowData() ?? {});
          return true;
        }
        case "merge": {
          event.preventDefault();
          const runs = serializeBlockRuns(lexicalEditor);
          api.merge({ runs });
          return true;
        }
        case "mergeNext":
          // Forward-delete: the runs come from the NEXT block (read via its own
          // handle inside `mergeNext`), never this editor — so no serialize here.
          event.preventDefault();
          api.mergeNext();
          return true;
        case "outdent":
          event.preventDefault();
          api.outdent();
          return true;
        case "unwrap":
          // The target is the CONTAINER (an anchor row that holds no caret and
          // has no `BlockEditorAPI` of its own), so this goes through the
          // editor-wide entry point rather than this block's api.
          event.preventDefault();
          unwrapRef.current(intent.blockId);
          return true;
        case "expand":
          // Also the CONTAINER, for the same reason — but `setExpanded` is a
          // per-block API, so address it by minting one for that id. The caret
          // stays exactly where it is: this press spends itself opening the box,
          // and the next one acts on the document now on screen.
          event.preventDefault();
          makeBlockAPIRef.current(intent.blockId).setExpanded(true);
          return true;
        case "markStep":
          // Selection only: the caret must NOT move, so the arrow's default is
          // suppressed and the linear offset is left exactly where it was. No
          // `recordDocEdit` and no `discrete` — those fence CONTENT mutations
          // off the typing run, and this changes none.
          event.preventDefault();
          markStep(lexicalEditor, intent.marks, intent.escaped);
          return true;
        case "markArrive":
          // The caret moves AND lands on the seam's stop, as one press. We place
          // it rather than letting the browser, because the stop is the state the
          // browser never picks — and because placing through
          // `$placeCaretAtLinearOffset` is what makes the resolver's lookahead
          // exact: it read the boundary off the very anchor this lands on.
          //
          // The stop is not asserted here. This IS a crossing, so it is
          // announced like every other one, and the page editor's own observer
          // of that channel (`registerMarkArrival`, mounted below) computes the
          // stop from the anchor the placement just produced — one
          // implementation of "which state does an arrival land on", shared with
          // the movers this module never sees.
          //
          // IT HAS TO BE `crossCaret`, NOT A PLACEMENT FOLLOWED BY A BARE
          // `announceCaretCrossing`. The two read as equivalent and are not.
          // This runs inside a Lexical command listener, i.e. inside an active
          // update, and Lexical treats the two halves asymmetrically there: a
          // nested `editor.update(...)` is QUEUED behind the listener
          // (`updateEditor`, lexical@0.44.0 `Lexical.dev.mjs:9143`), while
          // `dispatchCommand` runs its listeners INLINE (`updateEditorSync`,
          // `:9136` — it calls `updateFn()` straight through when
          // `activeEditor === editor` and no options are passed). So "place,
          // then announce" spelled as an update followed by a call ANNOUNCES
          // FIRST: the observer reads the pre-move anchor at the block's end,
          // where there is no stop, never arms `escaped`, and the next
          // ArrowLeft steps past the seam instead of being absorbed by it.
          // `crossCaret` moves and announces as one act, so the order cannot
          // invert — this update is queued as a whole, and inside it the
          // placement is already committed to the pending state by the time the
          // dispatch runs.
          //
          // No `focusEditor` (which `placeCaretAtOffset` would have done): the
          // keystroke was delivered to this editor's own root, so it already
          // holds DOM focus. The tag is that helper's no-scroll landing.
          event.preventDefault();
          lexicalEditor.update(
            () =>
              crossCaret(lexicalEditor, intent.dir, () =>
                $placeCaretAtOffset(intent.offset),
              ),
            { tag: SKIP_SCROLL_TAG },
          );
          return true;
        case "unmark": {
          event.preventDefault();
          // A Lexical command listener runs INSIDE an `editor.update()`, where a
          // nested `discrete: true` update is ENQUEUED rather than committed —
          // so an edit run here would land outside the run tracker's
          // `untracked` scope and be recorded as plain typing. `recordDocEdit`
          // defers the edit one microtask itself (the same contract the inline
          // autoformat keeps); `removeMarkSpan` throws rather than degrade if
          // it is ever violated.
          //
          // Deferring means the caret may have moved, hence the plan: snapshot
          // the live position now, re-verify it there, and abort changing
          // nothing on drift (which records nothing — a free no-op).
          const plan = lexicalEditor
            .getEditorState()
            .read(() => $scanMarkSpan(intent.delimiter));
          if (plan === null) return true;
          // Its own undo entry, fenced off the 500ms typing run on both sides:
          // ONE Cmd+Z restores the mark and nothing else.
          recordDocEditRef.current(
            blockIdRef.current,
            "Remove formatting",
            () => {
              removeMarkSpan(lexicalEditor, plan);
            },
          );
          return true;
        }
        case "indent":
          event.preventDefault();
          api.indent();
          return true;
        case "nav":
          event.preventDefault();
          api.navigate(intent.dir, caret);
          return true;
        case "extendSpan": {
          // The native selection cannot leave this editing host, so the editor
          // takes the gesture over: a span anchored where the native selection
          // is anchored (`caret.offset` is the ANCHOR's offset), its head in
          // the neighbouring line at the focus's column. Not consumed when the
          // surface finds no line that way — the browser extends in-block.
          const selection = selectionRef.current;
          if (!selection) return false;
          if (
            !selection.extendSpan(
              blockIdRef.current,
              caret.offset,
              intent.dir,
              caret.focus.x,
            )
          )
            return false;
          event.preventDefault();
          return true;
        }
      }
    }

    function handle(key: KeystrokeKey, event: KeyboardEvent | null): boolean {
      if (!event || event.isComposing) return false;
      // The mark-delimiter depth is passed IN rather than read by the geometry
      // module, which keeps that module free of module state; it is verified
      // against the live anchor inside the same read.
      const caret = readCaretContext(
        lexicalEditor,
        readMarkDepth(lexicalEditor),
      );
      if (!caret) return false;
      // Zoomed, the ladders see only the view — see `IntentContext.nodes`.
      const allNodes = toNodes(rowsRef.current);
      const nodes =
        scopeRootId === null ? allNodes : scopeNodes(allNodes, scopeRootId);
      // Resolve the current block's declarative edit policy from the registry.
      // `splitChildWhenExpanded` is render-state-dependent (the live `expanded`
      // flag), so it folds into the same policy here rather than being drilled.
      const handleOf = (type: string) =>
        contributionsRef.current.find((c) => c.block.type === type)?.block;
      const node = nodes.find((b) => b.id === blockIdRef.current);
      const handle = handleOf(node?.type ?? "");
      const editPolicy = {
        asChild:
          handle?.splitChildWhenExpanded && node?.expanded ? true : undefined,
        childType: handle?.splitChildWhenExpanded?.childType,
        splitInto: handle?.splitInto,
        resetToOnBackspaceAtStart: handle?.resetToOnBackspaceAtStart,
        breakOutOnEmptyEnter: handle?.breakOutOnEmptyEnter,
        // The tail's `data` transform (e.g. checked to-do → unchecked tail),
        // bound to its handle so the resolver can invoke it without the handle.
        dataOnSplit: handle?.dataOnSplit?.bind(handle),
      };
      const intent = resolveKeystroke(key, { shift: event.shiftKey }, caret, {
        nodes,
        scopeRootId,
        blockId: blockIdRef.current,
        // Type facts from the same registry, resolved per node (the ladders ask
        // about OTHER blocks — the line above, the line below, the parent — not
        // just this one). An unregistered type is text-less and not an anchor:
        // refusing only demotes a structural keystroke to a caret move, whereas
        // assuming text would hand the write boundary a payload it rejects.
        acceptsText: (n) => handleOf(n.type)?.acceptsText === true,
        isAnchor: (n) => handleOf(n.type)?.anchor === true,
        editPolicy,
      });
      return execute(intent, event, caret);
    }

    const reg = (
      cmd: LexicalCommand<KeyboardEvent | null>,
      key: KeystrokeKey,
    ) =>
      lexicalEditor.registerCommand(
        cmd,
        (e) => handle(key, e),
        COMMAND_PRIORITY_HIGH,
      );

    const unregister = [
      // Both halves of the caret's SECOND component — the mark stop, which this
      // editor owns beside Lexical's selection — mount from this one place.
      //
      // The store's own lifecycle: cleared on any update with dirty leaves,
      // re-asserted onto `selection.format` on every selection change while it
      // is valid.
      registerMarkDepth(lexicalEditor),
      // And its arrival path: the crossing-channel observer that lands the caret
      // on a boundary's stop after ANY announced crossing — this module's own
      // `markArrive`, a cross-block landing, a step across an inline decorator,
      // or a mover neither of them knows about.
      registerMarkArrival(lexicalEditor),
      reg(KEY_ENTER_COMMAND, "Enter"),
      reg(KEY_BACKSPACE_COMMAND, "Backspace"),
      reg(KEY_DELETE_COMMAND, "Delete"),
      reg(KEY_TAB_COMMAND, "Tab"),
      reg(KEY_ARROW_UP_COMMAND, "ArrowUp"),
      reg(KEY_ARROW_DOWN_COMMAND, "ArrowDown"),
      reg(KEY_ARROW_LEFT_COMMAND, "ArrowLeft"),
      reg(KEY_ARROW_RIGHT_COMMAND, "ArrowRight"),
      // Escape leaves text editing and selects the whole block — not a caret move,
      // so it stays a direct handler rather than flowing through the resolver.
      lexicalEditor.registerCommand<KeyboardEvent | null>(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (!selectionRef.current) return false;
          event?.preventDefault();
          selectionRef.current.enterSelectionMode(blockIdRef.current);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // Cmd+A is a two-step ladder, like Notion (`internal/select-all-ladder.ts`):
      // the first press selects the block's text (Lexical's own handler, reached
      // by returning false); once there is no more text to select — the block is
      // empty, or its text is already all selected — it selects every block.
      lexicalEditor.registerCommand<KeyboardEvent>(
        SELECT_ALL_COMMAND,
        (event) => {
          if (!selectionRef.current) return false;
          const nothingMoreToSelect = lexicalEditor
            .getEditorState()
            .read(() => {
              const text = $getRoot().getTextContent();
              if (text === "") return true;
              const sel = $getSelection();
              return $isRangeSelection(sel) && sel.getTextContent() === text;
            });
          if (!nothingMoreToSelect) return false;
          event.preventDefault();
          selectionRef.current.selectAll();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];

    return () => {
      for (const u of unregister) u();
    };
  }, [lexicalEditor, rowsRef, recordDocEditRef, scopeRootId]);

  // Undo/redo (Cmd+Z / Cmd+Shift+Z / Cmd+Y) is NOT handled per-block. With no
  // Lexical `HistoryPlugin`, nothing here consumes those keystrokes, so the native
  // keydown bubbles out to the surface-level `useUndoRedoShortcuts` binding (the
  // tab's, in `apps-core/tab-surface`). That binding reaches the caret sitting in
  // a block because the block list declares `surfaceUndoProps`, and it still fires
  // after a structural undo leaves DOM focus on <body>.

  return null;
}
