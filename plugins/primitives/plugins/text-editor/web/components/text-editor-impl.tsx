import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DROP_COMMAND } from "lexical";
import { buildInitialConfig } from "../internal/lexical-config";
import { EnterKeyPlugin } from "../internal/enter-key-plugin";
import { DecoratorNavPlugin } from "@plugins/primitives/plugins/text-editor/plugins/decorator-nav/web";
import { DecoratorBlockPlugin } from "../internal/decorator-block-plugin";
import { TokenPastePlugin } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import { TextEditorSlots } from "../slots";
import {
  getNodeExtensions,
  type NodeExtension,
} from "../internal/node-extensions";
import {
  applyMarkdownToEditor,
  serializeEditorToMarkdown,
  $selectMarkdownRange,
} from "../internal/markdown";
import { useInsertMarkdown } from "../internal/use-insert-markdown";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";

export interface TextEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit?: () => void;
  submitMode?: "enter" | "cmd-enter" | "none";
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  minRows?: number;
  maxHeight?: string;
  namespace?: string;
  onError?: (msg: string) => void;
  insertRef?: React.MutableRefObject<((text: string) => void) | null>;
  // Character range [start, end] in the raw `value` to select on mount.
  // Used to open the editor with a span pre-selected (e.g. drag-select-to-edit).
  initialSelection?: { start: number; end: number } | null;
  bottomSlot?: React.ReactNode;
}

export function TextEditor({
  value,
  onChange,
  onSubmit,
  submitMode = "cmd-enter",
  placeholder,
  disabled,
  autoFocus,
  className,
  minRows = 3,
  maxHeight,
  namespace = "text-editor",
  onError,
  insertRef,
  initialSelection,
  bottomSlot,
}: TextEditorProps) {
  // Read at render, never memoized: the registry folds in lazy sources whose
  // families register as the plugin tiers load (see `getNodeExtensions`).
  const extensions = getNodeExtensions();
  // The Lexical composer must know every node class up-front and must not be
  // rebuilt (that remounts the editor). The node-class set is fixed at boot, so
  // key the config on the node types — `extensions` identity churns each render.
  const nodeKey = extensions.map((ext) => ext.node.type).join("|");
  const initialConfig = useMemo(
    () =>
      buildInitialConfig({
        namespace,
        onError: (err) =>
          onError?.(err instanceof Error ? err.message : String(err)),
        extensions,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeKey captures the boot-stable node-class set; `extensions` identity churns each render
    [namespace, onError, nodeKey],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorShell
        placeholder={placeholder}
        disabled={!!disabled}
        autoFocus={!!autoFocus}
        className={className}
        minRows={minRows}
        maxHeight={maxHeight}
        bottomSlot={bottomSlot}
      />
      <ValueSyncPlugin
        value={value}
        onChange={onChange}
        extensions={extensions}
      />
      {initialSelection && (
        <InitialSelectionPlugin
          selection={initialSelection}
          extensions={extensions}
        />
      )}
      <PluginSlot onError={onError} />
      <DecoratorNavPlugin />
      <DecoratorBlockPlugin />
      <TokenPastePlugin extensions={extensions} />
      {onSubmit && submitMode !== "none" && (
        <EnterKeyPlugin onSubmit={onSubmit} submitMode={submitMode} />
      )}
      {insertRef && <InsertPlugin insertRef={insertRef} />}
      <HistoryPlugin />
    </LexicalComposer>
  );
}

// Imperative insert-at-caret handle: publishes the editor's own insert (see
// `useInsertMarkdown`) to a caller outside the composer.
function InsertPlugin({
  insertRef,
}: {
  insertRef: React.MutableRefObject<((text: string) => void) | null>;
}) {
  const insert = useInsertMarkdown();
  useEffect(() => {
    insertRef.current = insert;
    return () => {
      insertRef.current = null;
    };
  }, [insert, insertRef]);
  return null;
}

// Selects a raw-string character range once on mount. Rendered after
// ValueSyncPlugin so its mount effect runs after the value has been applied to
// the editor (React fires sibling effects in render order), guaranteeing the
// target nodes exist before we place the selection.
function InitialSelectionPlugin({
  selection,
  extensions,
}: {
  selection: { start: number; end: number };
  extensions: readonly NodeExtension[];
}) {
  const [editor] = useLexicalComposerContext();
  const extensionsRef = useLatestRef(extensions);
  const selectionRef = useLatestRef(selection);
  useEffect(() => {
    editor.focus();
    editor.update(() => {
      const { start, end } = selectionRef.current;
      $selectMarkdownRange(start, end, extensionsRef.current);
    });
    // Mount-only: apply the captured selection once. `editor` is stable and the
    // refs are stable useLatestRef handles, so the effect never re-runs.
  }, [editor]);
  return null;
}

function EditorShell({
  placeholder,
  disabled,
  autoFocus,
  className,
  minRows,
  maxHeight,
  bottomSlot,
}: {
  placeholder?: string;
  disabled: boolean;
  autoFocus: boolean;
  className?: string;
  minRows: number;
  maxHeight?: string;
  bottomSlot?: React.ReactNode;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // Frozen at mount: `autoFocus` means "take focus when the editor appears",
  // not "take it whenever this prop turns true".
  const [focusOnMount] = useState(autoFocus && !disabled);

  const minHeight = `${Math.max(minRows, 1) * 1.5}rem`;

  // The whole box is the drop target, not just the editable: a file dropped on
  // the padding or the bottom bar is dispatched as a drop into the editor, so
  // whichever editor plugin claims dropped files handles it. A drop on the
  // editable itself is Lexical's own to dispatch.
  const [fileDragOver, setFileDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setFileDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFileDragOver(false);
      }}
      onDrop={(e) => {
        setFileDragOver(false);
        if (disabled || e.defaultPrevented) return;
        // Lexical dispatched this one itself: never a second time.
        if (editor.getRootElement()?.contains(e.target as Node)) return;
        if (!e.dataTransfer.types.includes("Files")) return;
        if (editor.dispatchCommand(DROP_COMMAND, e.nativeEvent)) {
          e.preventDefault();
        }
      }}
      // Yields, never grows: the self-contained editor box falls below its
      // content width inside an arbitrary external flex parent.
      // The box is a card: the shape group's card corners, the density
      // group's `padComposer` (none by default) and the palette's `composer`
      // fill (transparent, or `input` at 30% in dark mode, by default).
      className={cn(
        yieldClass("x"),
        "focus-border-within w-full rounded-card border p-composer transition-colors",
        fileDragOver ? "border-primary" : "border-input",
        disabled ? "bg-input/50 dark:bg-input/80" : "bg-composer",
      )}
    >
      {/* One grid cell holds both the editable and its placeholder, so the box
          is as tall as whichever is taller: a placeholder that wraps past
          `minRows` grows the editor instead of spilling over `bottomSlot`. */}
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- stacks Lexical's two sibling children (ContentEditable + placeholder, a third-party Fragment) in one in-flow cell; no primitive stacks siblings in flow
        className={cn(
          // Every direct child into cell 1/1: Lexical wraps the placeholder in
          // its own `<div aria-hidden>`, so the placement cannot sit on our node
          // — and that wrapper, painted above the editable, must pass clicks.
          "grid *:col-start-1 *:row-start-1 [&>[aria-hidden]]:pointer-events-none",
          disabled && "opacity-50 pointer-events-none cursor-not-allowed",
        )}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              // This editor mounts its own `HistoryPlugin` (below), so ⌘Z here
              // is an edit to THIS editor and nothing else — claimed back from
              // any surface-undo region it happens to be rendered inside.
              {...localUndoProps}
              style={{ minHeight, maxHeight }}
              // eslint-disable-next-line layout/no-adhoc-layout -- overflow-y-auto configures the scroll on Lexical's third-party ContentEditable element (its own clamped editor viewport), not a primitive boundary
              className={cn(
                "min-w-0 p-composer-text text-body outline-none resize-none",
                "overflow-y-auto",
                className,
              )}
              aria-disabled={disabled}
              aria-placeholder={placeholder ?? ""}
              placeholder={
                // Shares the editable's grid cell (see the wrapper above) and so
                // counts toward the box's height, unlike an absolute overlay.
                <div className="text-faint-foreground pointer-events-none select-none p-composer-text text-body">
                  {placeholder ?? ""}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        {/* Lexical's own plugin, not a bare `editor.focus()`: that only moves
            the selection, and in a just-mounted editor whose root is still
            empty there is none to move, so DOM focus is never taken. This is
            what a lazily loaded editor landing inside an already-open popover
            hits — the popover has focused its first control by then. The
            plugin's callback focuses the root when selection did not. */}
        {focusOnMount && <AutoFocusPlugin />}
      </div>
      {bottomSlot}
    </div>
  );
}

function PluginSlot({ onError }: { onError?: (msg: string) => void }) {
  return (
    <TextEditorSlots.Plugin.Render>
      {(item) => <item.component onError={onError} />}
    </TextEditorSlots.Plugin.Render>
  );
}

function ValueSyncPlugin({
  value,
  onChange,
  extensions,
}: {
  value: string;
  onChange: (markdown: string) => void;
  extensions: readonly NodeExtension[];
}) {
  const [editor] = useLexicalComposerContext();
  const selfWriteRef = useRef(false);
  const lastSerializedRef = useRef<string | null>(null);
  const onChangeRef = useLatestRef(onChange);
  // Read fresh inside effects so the (boot-stable) extension set is never a
  // dependency that would re-run the markdown sync.
  const extensionsRef = useLatestRef(extensions);

  useEffect(() => {
    if (lastSerializedRef.current === value) return;
    selfWriteRef.current = true;
    applyMarkdownToEditor(editor, value, extensionsRef.current);
    lastSerializedRef.current = value;
    queueMicrotask(() => {
      selfWriteRef.current = false;
    });
  }, [editor, value]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (selfWriteRef.current) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      const md = serializeEditorToMarkdown(editor, extensionsRef.current);
      if (md === lastSerializedRef.current) return;
      lastSerializedRef.current = md;
      onChangeRef.current(md);
    });
  }, [editor]);

  return null;
}
