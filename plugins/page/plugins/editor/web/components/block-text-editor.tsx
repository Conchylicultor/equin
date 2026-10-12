import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { insetClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LinkNode } from "@lexical/link";
import { DecoratorNavPlugin } from "@plugins/primitives/plugins/text-editor/plugins/decorator-nav/web";
import { announceCaretCrossing } from "@plugins/primitives/plugins/text-editor/plugins/caret-motion/web";
import { TokenPastePlugin } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
} from "lexical";
import {
  runsOf,
  type Block,
  type BlockTextVariant,
  type RichText,
} from "../../core";
import type { BlockEditorAPI } from "../types";
import { useBlockEditor } from "../block-editor-context";
import { CollabTextPlugin } from "./collab-text-plugin";
import { KeyboardPlugin } from "./keyboard-plugin";
import { BlockMenuPlugin } from "./block-menu-plugin";
import { MarkdownShortcutPlugin } from "./markdown-shortcut-plugin";
import { InlineMarkdownPlugin } from "./inline-markdown-plugin";
import { FormatToolbarPlugin } from "./format-toolbar-plugin";
import { FormatShortcutsPlugin } from "./format-shortcuts-plugin";
import { BlockPastePlugin } from "./block-paste-plugin";
import { BlockForestCopyPlugin } from "./block-forest-copy-plugin";
import { BlockClipboardInsertPlugin } from "./block-clipboard-insert-plugin";
import { BlockForestPastePlugin } from "./block-forest-paste-plugin";
import {
  blockTextNodes,
  blockTextTokenExtensions,
  getBlockTextExtensions,
  serializeBlockRuns,
} from "../internal/block-text-extensions";
import { isValidLinkUrl } from "../internal/link-url";
import { BLOCK_INSET } from "../internal/page-column";
import {
  linearDomRange,
  linearOffsetAtPoint,
  nativeAnchorLinearOffset,
  placeCaretAtBoundary,
  placeCaretAtColumn,
  placeCaretAtOffset,
} from "../internal/caret-geometry";
import {
  appendRunsAtJoin,
  deleteBlockTextRange,
  focusHydratingAware,
  truncateBlockTextFrom,
} from "../internal/collab-text-surgery";
import type { FlightInput } from "../internal/caret-authority";
import type { KeystrokeKey } from "../internal/keystroke-intent";
import { TEXT_VARIANT_CLASS } from "./text-variant-class";

/**
 * The Lexical command each buffered {@link KeystrokeKey} replays through, so a
 * keystroke the caret authority held while this editor was mounting resolves
 * through the SAME `resolveKeystroke` step a real one does — including a
 * replayed Enter re-entering `split()`, which claims the next flight.
 * `satisfies` makes a drift from `KeystrokeKey` a tsc error.
 */
const REPLAY_COMMANDS = {
  Enter: KEY_ENTER_COMMAND,
  Backspace: KEY_BACKSPACE_COMMAND,
  Delete: KEY_DELETE_COMMAND,
  Tab: KEY_TAB_COMMAND,
  ArrowUp: KEY_ARROW_UP_COMMAND,
  ArrowDown: KEY_ARROW_DOWN_COMMAND,
  ArrowLeft: KEY_ARROW_LEFT_COMMAND,
  ArrowRight: KEY_ARROW_RIGHT_COMMAND,
} satisfies Record<KeystrokeKey, LexicalCommand<KeyboardEvent | null>>;

/**
 * Apply input the caret authority buffered while this editor was still mounting.
 *
 * ONE CHARACTER PER COMMIT, deliberately — do NOT coalesce a text run into a
 * single `insertText`. Every incremental transform in the editor keys on the
 * text CHANGING one character at a time: the block markdown shortcut fires on
 * the `"- "` → `"- x"` transition, and the inline one is stricter still
 * (exactly-one-char-typed, its defence against re-formatting on Backspace). A
 * coalesced insert never presents those intermediate states, so replaying
 * `"- Bravo bullet"` in one go left the block a plain paragraph and the Enter
 * after it inherited `text` instead of `bulleted-list`. Coalescing was an
 * optimization against a cost that does not exist: the block's run tracker
 * folds a typing run into ONE undo entry via its 500ms idle window, exactly as
 * it does for a real burst.
 *
 * A key replays as its Lexical command carrying a SYNTHETIC `KeyboardEvent`:
 * `KeyboardPlugin.handle` takes `KeyboardEvent | null` and only needs a real
 * object to read `key`/`shiftKey` off (its `preventDefault()` on an untrusted
 * event is a harmless no-op), so nothing about the intent resolution knows it
 * was replayed.
 */
function replayBufferedInput(
  editor: LexicalEditor,
  entries: readonly FlightInput[],
): void {
  for (const entry of entries) {
    if (entry.kind === "text") {
      editor.update(
        () => {
          const selection = $getSelection();
          // The authority only replays into a caret-READY editor, so a range
          // selection is the expected state. Anything else is still recoverable —
          // land at the content end rather than dropping what the user typed,
          // which is the one outcome this whole mechanism exists to prevent.
          if ($isRangeSelection(selection)) selection.insertText(entry.text);
          else $getRoot().selectEnd().insertText(entry.text);
        },
        // `discrete` is LOAD-BEARING, for the same reason `truncateBlockTextFrom`
        // and `appendRunsAtJoin` pass it. Lexical's default commit is a MICROTASK,
        // so without it the next entry resolves against the PRE-insert state:
        // `readCaretContext` reports offset 0 and `serializeBlockRuns` empty runs,
        // `resolveKeystroke` sees an empty block, and a following Enter splits at
        // `position: 0, runs: []` — whose `truncateAt(0)` wipes the content doc.
        // "alpha⏎bravo⏎charlie" came out as ["alpha","","charlie"]. It is equally
        // what makes each character visible to the incremental transforms above.
        { discrete: true },
      );
      continue;
    }
    const consumed = editor.dispatchCommand(
      REPLAY_COMMANDS[entry.key],
      new KeyboardEvent("keydown", { key: entry.key, shiftKey: entry.shift }),
    );
    if (!consumed) applyDefaultAction(editor, entry);
  }
}

/**
 * Perform what the BROWSER would have done for a key no command listener
 * consumed.
 *
 * A live keystroke has two halves: the command dispatch, and — if nobody
 * returned true — the browser's default action. A replay only has the first,
 * because `dispatchCommand` is not a DOM event and a synthetic `KeyboardEvent`
 * is untrusted, so it has no default action to run. Most keys never reach here
 * (Lexical's own rich-text listeners consume Enter, Shift+Enter, Backspace and
 * Delete; `resolveKeystroke` consumes Tab), but ORDINARY CARET MOVEMENT is left
 * to the browser: `KEY_ARROW_LEFT_COMMAND` returns false for a caret that isn't
 * at a block edge, and the replay used to drop it on the floor. Five buffered
 * ArrowLefts silently did nothing, so the Enter after them split at the END of
 * the block instead of mid-word — `["splitXtail", "typed-immediately-"]` where
 * the user typed their way to `["split", "typed-immediately-Xtail"]`.
 *
 * `selection.modify` is the model-level equal of a horizontal caret move, so
 * Left/Right (and their shift-extend forms) replay exactly.
 *
 * KNOWN BOUND — an unconsumed ArrowUp/ArrowDown is NOT reproduced. Unconsumed
 * means the caret is not on the block's first/last visual line (a boundary press
 * resolves to a cross-block `nav`, which IS consumed), i.e. it is a move between
 * VISUAL lines inside one wrapped block — and visual lines exist only in layout,
 * with no model-level equivalent to `modify`. Rather than approximate it with a
 * line-boundary jump that lands somewhere the user did not ask for, the move is
 * dropped: it costs a caret position in a rare case, never content.
 */
function applyDefaultAction(editor: LexicalEditor, entry: FlightInput): void {
  if (entry.kind !== "key") return;
  if (entry.key !== "ArrowLeft" && entry.key !== "ArrowRight") return;
  const isBackward = entry.key === "ArrowLeft";
  editor.update(
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      selection.modify(
        entry.shift ? "extend" : "move",
        isBackward,
        "character",
      );
    },
    // Same reason as the text flush: the NEXT replayed key resolves against the
    // committed state, so this move must be committed before it runs.
    { discrete: true },
  );
}

function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  return null;
}

/**
 * The editable-text LEAF: the entire Lexical pipeline — the per-block CRDT
 * binding, structural keyboard handling, the slash menu, and the markdown
 * block-shortcut affordance — and nothing else.
 *
 * It owns no layout. The line wrapper, the leading-marker gutter and the leaf
 * cell all live in `TextBlockLayout`, which renders this as its `children`, so
 * the element chain above `<LexicalComposer>` is constant across every
 * text-bearing block type (see that file for why). Consequence: the marker
 * gutter now sits OUTSIDE the composer — nothing reads Lexical context from a
 * marker today, and arguably a region should not be able to.
 *
 * Deliberately NOT exported from the web barrel: a block type never renders this
 * itself, it declares `chrome` and lets the shared renderer place it.
 */
export function BlockTextEditor({
  block,
  isFocused,
  editor,
  placeholder,
  contentClassName,
  textVariant,
}: {
  block: Block;
  isFocused: boolean;
  editor: BlockEditorAPI;
  /** Shown when the block is empty and focused. */
  placeholder?: ReactNode;
  /** Extra classes for the editable content (e.g. strikethrough when done). */
  contentClassName?: ClassName;
  /** Semantic typography variant for the editable text and placeholder. */
  textVariant: BlockTextVariant;
}) {
  const runs = runsOf((block.data as Record<string, unknown> | null)?.text);
  const isEmpty = runs.length === 0;
  const { registerFocusHandle, blockMenuDraftId } = useBlockEditor();
  // While the gutter-`+` draft menu is open on this block, the block's own text
  // is the menu's inline filter — so the placeholder invites that.
  const effectivePlaceholder =
    blockMenuDraftId === block.id ? "Type to filter" : placeholder;
  const lexicalEditorRef = useRef<LexicalEditor | null>(null);

  const initialConfig = useMemo(
    () => ({
      namespace: `block-text-${block.id}`,
      theme: {
        paragraph: "m-0",
        // Inline mark classes — applied by Lexical to formatted TextNodes. These
        // are plain class strings passed to the framework (not JSX className), so
        // they map marks → utilities directly.
        text: {
          bold: "font-bold",
          italic: "italic",
          underline: "underline",
          strikethrough: "line-through",
          code: "rounded-md bg-muted px-xs font-mono text-[0.9em]",
        },
        link: "text-primary-text underline",
      },
      // Custom inline nodes (e.g. inline page links) contributed via
      // registerBlockTextExtension, plus LinkNode for inline links. Registered
      // at app bootstrap, so present before any block editor mounts.
      nodes: [LinkNode, ...blockTextNodes()],
      onError: console.error,
      // Skip Lexical's default empty-paragraph bootstrap — content arrives
      // exclusively via the collab sync (the pre-seeded per-block doc), and a
      // locally-bootstrapped paragraph would be a divergent local edit.
      editorState: null,
    }),
    [block.id],
  );

  useEffect(() => {
    return registerFocusHandle(block.id, {
      focus: (opts) => {
        const ed = lexicalEditorRef.current;
        if (!ed) return;
        // The content doc syncs async after mount, and Lexical's focus() is a
        // no-op on a still-empty root — use the hydration-aware focus (DOM
        // focus now, caret to content start on first sync). `opts.scroll`
        // (default false) declares whether the landing follows the caret;
        // `opts.onLanded` is how the caret authority learns the caret is really
        // HERE (not merely mounted) and can flush what it buffered meanwhile;
        // `opts.onLandingLost` is its failure dual, for the hydrating landing
        // that has to be abandoned because focus moved away meanwhile.
        focusHydratingAware(ed, opts?.scroll ?? false, opts);
      },
      // The two column/boundary placements are synchronous by construction
      // (they land the caret against content that is already there), so they
      // report the landing as soon as they return.
      focusAtColumn: (x, edge, opts) => {
        const ed = lexicalEditorRef.current;
        if (!ed) return;
        placeCaretAtColumn(ed, x, edge, opts?.scroll ?? false);
        opts?.onLanded?.();
      },
      focusBoundary: (edge, opts) => {
        const ed = lexicalEditorRef.current;
        if (!ed) return;
        placeCaretAtBoundary(ed, edge, opts?.scroll ?? false);
        // A landing that crossed something says so, in the direction it was
        // travelling; anything else (a click, a focus restore, a vertical
        // crossing) declares no `crossing` and lands exactly where it did
        // before. This host speaks only the generic vocabulary — what a crossing
        // MEANS belongs to whoever observes the channel, because a block's edge
        // can be a position holding more state than a placement produces (the
        // page editor's own observer, for inline-mark boundaries, is
        // `internal/mark-arrival.ts`).
        if (opts?.crossing) announceCaretCrossing(ed, opts.crossing);
        opts?.onLanded?.();
      },
      // Hydration-aware like `focus`: an offset landing can target a block the
      // same gesture just created (a splice's last line), whose root is still
      // childless — placing the caret into nothing would land it nowhere and
      // report the landing anyway.
      focusOffset: (n, opts) => {
        const ed = lexicalEditorRef.current;
        if (!ed) return;
        const scroll = opts?.scroll ?? false;
        focusHydratingAware(ed, scroll, opts, () =>
          placeCaretAtOffset(ed, n, scroll),
        );
      },
      // Everything the user typed while this editor was mounting. Registering it
      // is what makes this block a legal flight target at all — a handle without
      // it has nowhere to put buffered keystrokes, and the authority refuses to
      // land there (loudly) rather than dropping them.
      replayInput: (entries) => {
        const ed = lexicalEditorRef.current;
        if (ed) replayBufferedInput(ed, entries);
      },
      // Content surgery: split/merge drive the LIVE content through Lexical so
      // the collab binding syncs the change into the block's content doc
      // (marks + decorator tokens preserved, like any local edit).
      truncateAt: (offset: number) => {
        const ed = lexicalEditorRef.current;
        if (ed) truncateBlockTextFrom(ed, offset);
      },
      appendRunsAtEnd: (runs: RichText) => {
        const ed = lexicalEditorRef.current;
        if (ed) appendRunsAtJoin(ed, runs);
      },
      deleteRange: (from: number, to: number) => {
        const ed = lexicalEditorRef.current;
        if (ed) deleteBlockTextRange(ed, from, to);
      },
      // The read dual of `appendRunsAtEnd`: serialize this block's LIVE runs (the
      // same call the keyboard plugin makes for split/convertTo/merge), so a
      // forward-delete in the PREVIOUS block can pull this block's freshly-typed
      // content up without waiting on the ~1s `data.text` projection.
      readRuns: () => {
        const ed = lexicalEditorRef.current;
        return ed ? serializeBlockRuns(ed) : [];
      },
      // Where a drop at a pointer position lands in this block's text — the
      // read half of `placeCaretAtColumn`'s hit-test, placing nothing.
      offsetAtPoint: (x: number, y: number) => {
        const ed = lexicalEditorRef.current;
        return ed ? linearOffsetAtPoint(ed, x, y) : null;
      },
      // The three reads an editor-owned text span is built and painted from
      // (`block-editor.tsx`, `text-span-highlight.tsx`). None selects anything.
      nativeAnchorOffset: () => {
        const ed = lexicalEditorRef.current;
        return ed ? nativeAnchorLinearOffset(ed) : null;
      },
      domRangeOf: (from: number, to: number) => {
        const ed = lexicalEditorRef.current;
        return ed ? linearDomRange(ed, from, to) : null;
      },
      onTextUpdate: (listener: () => void) => {
        const ed = lexicalEditorRef.current;
        if (!ed) {
          throw new Error(
            `block ${block.id}: onTextUpdate on a handle whose editor is not mounted`,
          );
        }
        return ed.registerUpdateListener(() => listener());
      },
    });
  }, [block.id, registerFocusHandle]);

  return (
    // `LexicalComposer` emits no DOM, so these all render directly inside
    // `TextBlockLayout`'s `relative` leaf cell — which is what the placeholder's
    // top-left `<Pin>` resolves against.
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            className={cn(
              "outline-none py-xs",
              insetClass({ r: BLOCK_INSET }),
              TEXT_VARIANT_CLASS[textVariant],
              contentClassName,
            )}
            onFocus={() => editor.onFocus()}
          />
        }
        placeholder={
          isEmpty && isFocused && effectivePlaceholder ? (
            <Pin
              to="top-left"
              // `base`, not Pin's `raised` default: the placeholder shares its
              // box with the focused caret, so it must not paint over it.
              layer="base"
              decorative
              // Decoration, not content. It sits INSIDE the leaf cell, which is
              // where a block type's `semantics` role lands — so left visible to
              // AT, an empty focused heading would be NAMED "Heading 1" by its
              // own placeholder. Lexical hides its own built-in placeholder for
              // the same reason.
              aria-hidden
              className={cn(
                "text-muted-foreground py-xs",
                insetClass({ r: BLOCK_INSET }),
                TEXT_VARIANT_CLASS[textVariant],
              )}
            >
              {effectivePlaceholder}
            </Pin>
          ) : null
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      {/* Wires TOGGLE_LINK_COMMAND → LinkNode; validateUrl gates the href to
          the allowed protocols, and a URL pasted over a SELECTED range wraps
          that range in a link. ClickableLinkPlugin opens a link in a new tab on
          a PLAIN click, as it does on cmd/ctrl- and middle-click; only a click
          that leaves a selected range (a drag across the link text) does not
          open it (`@lexical/link@0.44.0 LexicalLink.dev.mjs:847-907`). */}
      <LinkPlugin validateUrl={isValidLinkUrl} />
      <ClickableLinkPlugin newTab />
      {/* Per-block CRDT binding: content syncs through the block's Y.Doc,
          split/merge are content-doc-aware, and text edits ride the
          unified undo stack as the run tracker's data entries. */}
      <CollabTextPlugin block={block} textVariant={textVariant} />
      <KeyboardPlugin blockId={block.id} editor={editor} />
      {/* Crossing an inline decorator (a `@date` chip, an inline page link, an
          inline formula) in ONE arrow press. Mounted AFTER KeyboardPlugin so it
          registers second within the same priority bucket: the block-edge
          crossing above gets first refusal, and this only ever fires for a caret
          that has a decorator directly beside it — never at a block boundary,
          where the adjacent-sibling lookup finds nothing. */}
      <DecoratorNavPlugin />
      <BlockMenuPlugin blockId={block.id} />
      <MarkdownShortcutPlugin block={block} />
      {/* Block-level markdown PREFIXES first, then inline delimiters. The order
          is the layering: the inline transform can leave a prefix behind
          (`~~- foo~~` → `- foo`), and the block plugin tag-guards that away, so
          the block listener must already be registered when the inline one
          starts stamping INLINE_FORMAT_TAG. */}
      <InlineMarkdownPlugin blockId={block.id} />
      <FormatShortcutsPlugin />
      <FormatToolbarPlugin />
      <BlockPastePlugin block={block} editor={editor} />
      <BlockForestPastePlugin block={block} editor={editor} />
      <BlockForestCopyPlugin block={block} editor={editor} />
      {/* Registers on SELECTION_INSERT_CLIPBOARD_NODES_COMMAND, not PASTE_COMMAND
          — nothing else in the app or in @lexical/* registers on it, so mount
          order here is inert. The two paste plugins above short-circuit before
          Lexical's own insert ever runs, so this only ever sees what they
          declined. */}
      <BlockClipboardInsertPlugin />
      {getBlockTextExtensions().map((ext) =>
        ext.Plugin ? (
          <ext.Plugin key={ext.id} block={block} editor={editor} />
        ) : null,
      )}
      {/* Pasting single-line text that carries a registered token materializes
          it as its node. Without this the token lands as literal characters and
          stays literal FOREVER — `@lexical/yjs` rebuilds nodes from the doc's own
          `__type` metadata and nothing ever re-scans text already in a document.

          Its place in the `PASTE_COMMAND` chain is the whole of its behaviour:

            1 BlockPastePlugin       NORMAL  a pasted FILE (an upload, never text)
            2 BlockForestPastePlugin NORMAL  forest MIME, or any multi-line text
            3 UrlPastePlugin         LOW     a bare URL at a collapsed caret
            4 TokenPastePlugin       LOW     single-line text carrying a token
            5 RichText default       EDITOR  everything else

          (A URL pasted over a SELECTED range is `LinkPlugin`'s LOW listener,
          which wraps the range in a link. `UrlPastePlugin` declines every
          non-collapsed selection, so the two never compete for one paste.)

          BELOW NORMAL, because a file paste is an upload and a multi-line paste
          is STRUCTURAL — a token inside either must not hijack them. Which also
          means this only ever sees single-line text, so a plain inline insert is
          the whole of what it has to do.

          NOT above `UrlPastePlugin`: "a pasted URL becomes a link, with the
          Bookmark / Embed / Mention menu beside it" is a shipped affordance.
          Within one priority Lexical runs listeners in
          REGISTRATION order, which here is JSX order — hence this mount site,
          after the contributed `ext.Plugin`s that `UrlPastePlugin` is one of.
          Belt and braces, the two gates are provably disjoint: `inlineBoundary`'s
          `(?<!\/)` means an id sitting inside a URL path matches nothing.

          ABOVE EDITOR, so a token that would otherwise land as literal characters
          materializes instead.

          No CRDT surgery helper, deliberately. `collab-text-surgery.ts` is for
          edits driven from OUTSIDE a Lexical command; a `PASTE_COMMAND` listener
          already runs inside `editor.update()`, so `selection.insertNodes` syncs
          through the `@lexical/yjs` binding exactly like typing and is recorded
          by the block's run tracker for free. */}
      <TokenPastePlugin extensions={blockTextTokenExtensions()} />
      <EditorRefPlugin editorRef={lexicalEditorRef} />
    </LexicalComposer>
  );
}
