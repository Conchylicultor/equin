import { useEffect, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LinkNode } from "@lexical/link";
import {
  COMMAND_PRIORITY_CRITICAL,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
} from "lexical";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { DecoratorNavPlugin } from "@plugins/primitives/plugins/text-editor/plugins/decorator-nav/web";
import { TokenPastePlugin } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import type { RichText } from "../../core";
import {
  blockTextNodes,
  blockTextTokenExtensions,
  runsToLexical,
  serializeBlockRuns,
} from "../internal/block-text-extensions";
import { BLOCK_TEXT_THEME } from "../internal/block-text-theme";
import {
  linearOffsetAtPoint,
  placeCaretAtBoundary,
  placeCaretAtColumn,
  placeCaretAtOffset,
  readCaretContext,
} from "../internal/caret-geometry";
import { isValidLinkUrl } from "../internal/link-url";
import { FormatShortcutsPlugin } from "./format-shortcuts-plugin";
import { FormatToolbarPlugin } from "./format-toolbar-plugin";

/** Where the caret lands when a field mounts. */
export type RichTextFieldCaret =
  | "start"
  | "end"
  /** On the first (`top`) or last (`bottom`) line, at viewport column `x` — an arrival from above / below. */
  | { column: number; edge: "top" | "bottom" }
  /** At the viewport point a click landed on, else the end. */
  | { x: number; y: number };

/** A key press, with where the caret stood when it came. */
export interface RichTextFieldKey {
  key: string;
  shift: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  /** The caret is collapsed at the very start / end of the text. */
  atStart: boolean;
  atEnd: boolean;
  /** The caret is on the first / last VISUAL line. */
  onTopLine: boolean;
  onBottomLine: boolean;
  /** Viewport x of the caret — what an arrival in a neighbouring field keeps. */
  caretX: number;
}

export interface RichTextFieldProps {
  /** The runs the field opens with. Read ONCE, on mount: the field owns its text from then on. */
  initial: RichText;
  /** Every change of the text, as runs. */
  onChange(runs: RichText): void;
  /**
   * A key, before the editor acts on it. Return `true` to take it — the editor
   * then does nothing and the browser's default is prevented; `false` leaves it
   * to the editor (typing, marks, ←/→ inside the text, Shift+Enter's soft break).
   */
  onKey(key: RichTextFieldKey): boolean;
  caret: RichTextFieldCaret;
  onBlur?(e: React.FocusEvent<HTMLDivElement>): void;
  ariaLabel: string;
  className?: ClassName;
}

/**
 * Inline rich text held in a block's `data` — a `RichText` that is a FIELD of
 * the payload (a table's cell), not the block's own text. A block's own text
 * lives in its content `Y.Doc` and is edited by the block-text pipeline; this
 * edits a plain value, the way a `<textarea>` edits a string:
 *
 * - seeded from `initial` once, reporting every change through `onChange` —
 *   the OWNER decides when a change becomes a row write (one `update` per
 *   field visit is the usual answer: an intermediate keystroke is not worth
 *   a write, nor an undo entry);
 * - the page's marks, links and inline tokens, through the same registry,
 *   theme, format toolbar and shortcuts as a block's text, so a cell and a
 *   paragraph read and edit alike;
 * - its own keystroke history (`localUndoProps` + Lexical's history): while it
 *   is open ⌘Z undoes typing, and the page stack holds the owner's write.
 *
 * No block structure: Enter does not split, Backspace does not merge, there is
 * no slash menu. What those keys mean in a field — leave to the next cell, say
 * — is the owner's, through `onKey`, which sees where the caret stands.
 */
export function RichTextField({
  initial,
  onChange,
  onKey,
  caret,
  onBlur,
  ariaLabel,
  className,
}: RichTextFieldProps) {
  const initialConfig = {
    namespace: "rich-text-field",
    theme: BLOCK_TEXT_THEME,
    nodes: [LinkNode, ...blockTextNodes()],
    onError: console.error,
    editorState: () => runsToLexical(initial),
  };
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            {...localUndoProps}
            aria-label={ariaLabel}
            className={cn("outline-none", className)}
            onBlur={onBlur}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <LinkPlugin validateUrl={isValidLinkUrl} />
      <ClickableLinkPlugin newTab />
      <DecoratorNavPlugin />
      <FormatShortcutsPlugin />
      <FormatToolbarPlugin />
      <TokenPastePlugin extensions={blockTextTokenExtensions()} />
      <FieldPlugin onChange={onChange} onKey={onKey} caret={caret} />
    </LexicalComposer>
  );
}

function FieldPlugin({
  onChange,
  onKey,
  caret,
}: Pick<RichTextFieldProps, "onChange" | "onKey" | "caret">) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useLatestRef(onChange);
  const onKeyRef = useLatestRef(onKey);
  // The landing is a MOUNT fact: a re-render with a new `caret` must not move a
  // caret the user has since moved.
  const landing = useRef(caret);

  useEffect(() => {
    landCaret(editor, landing.current);
  }, [editor]);

  useEffect(
    () =>
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        // A selection-only update changed no text.
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        onChangeRef.current(serializeBlockRuns(editor));
      }),
    [editor, onChangeRef],
  );

  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (e: KeyboardEvent) => {
          if (e.isComposing) return false;
          const at = readCaretContext(editor);
          const taken = onKeyRef.current({
            key: e.key,
            shift: e.shiftKey,
            mod: e.metaKey || e.ctrlKey,
            alt: e.altKey,
            atStart: at?.atStart ?? true,
            atEnd: at?.atEnd ?? true,
            onTopLine: at?.onTopLine ?? true,
            onBottomLine: at?.onBottomLine ?? true,
            caretX: at?.caretX ?? 0,
          });
          if (taken) e.preventDefault();
          return taken;
        },
        // Ahead of every other handler: a key the owner takes must not ALSO
        // move the caret or insert a paragraph.
        COMMAND_PRIORITY_CRITICAL,
      ),
    [editor, onKeyRef],
  );
  return null;
}

function landCaret(editor: LexicalEditor, caret: RichTextFieldCaret): void {
  if (caret === "start" || caret === "end") {
    placeCaretAtBoundary(editor, caret);
  } else if ("column" in caret) {
    placeCaretAtColumn(editor, caret.column, caret.edge);
  } else {
    const offset = linearOffsetAtPoint(editor, caret.x, caret.y);
    if (offset === null) placeCaretAtBoundary(editor, "end");
    else placeCaretAtOffset(editor, offset);
  }
}
