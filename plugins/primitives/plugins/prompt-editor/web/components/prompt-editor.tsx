import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { GrowRelay } from "@plugins/primitives/plugins/css/plugins/grow-relay/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useCallback, useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  TextEditor,
  useInsertMarkdown,
  useTakeMarkdownWith,
} from "@plugins/primitives/plugins/text-editor/web";
import { AttachFilesButton } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  workspaceAllows,
  type WorkspaceKindState,
} from "@plugins/conversations/plugins/workspace/core";
import { PromptEditorSlots } from "../slots";

type FloatingActionItem = Parameters<
  NonNullable<
    React.ComponentProps<
      typeof PromptEditorSlots.FloatingAction.Render
    >["children"]
  >
>[0];

export function PromptEditor(props: {
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
  /** The conversation's workspace: gates each action's `requires`. */
  workspace: WorkspaceKindState;
}) {
  const { workspace, ...editorProps } = props;
  return (
    <TextEditor
      {...editorProps}
      bottomSlot={<ToolbarRow onError={props.onError} workspace={workspace} />}
    />
  );
}

const disabledPartCls = "opacity-50 pointer-events-none select-none";

function ToolbarRow({
  onError,
  workspace,
}: {
  onError?: (msg: string) => void;
  workspace: WorkspaceKindState;
}) {
  const [editor] = useLexicalComposerContext();
  const [editable, setEditable] = useState(() => editor.isEditable());
  const items = PromptEditorSlots.FloatingAction.useContributions().filter(
    (i) => workspaceAllows(workspace, i.requires),
  );

  useEffect(() => {
    return editor.registerEditableListener(setEditable);
  }, [editor]);

  // The editor's own insert — same path as the imperative `insertRef` handle,
  // so a template snippet lands exactly like any other: line breaks as line
  // breaks, tokens as their nodes, at the caret (or the end when there is none).
  const insertText = useInsertMarkdown();

  // Insert-then-send built on that same insert, so a sent snippet lands where
  // the insert-only path would have put it.
  const takeDraftWith = useTakeMarkdownWith();

  const focusEditor = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        e.preventDefault();
        editor.focus();
      }
    },
    [editor],
  );

  const renderItem = useCallback(
    (item: FloatingActionItem) => {
      if (!workspaceAllows(workspace, item.requires)) return null;
      const dimmed =
        !editable && !item.alwaysActive ? disabledPartCls : undefined;
      const action = (
        <item.component insertText={insertText} takeDraftWith={takeDraftWith} />
      );
      // This box carries the disabled dimming, and it sits INSIDE the slot's own
      // per-contribution cell — so it is also where that cell's chain continues.
      // A widget that needs the row's room would shrink-wrap here and hand its
      // own content back to itself as "the room I have", so the box relays: it
      // grows when something under it asked, and the ask travels on to the cell.
      // Nothing here reads `item.fill`, because nothing has to be declared.
      return (
        <GrowRelay>
          {(asked) => (
            <div
              className={cn(asked ? fillClasses("x") : yieldClass("x"), dimmed)}
            >
              {action}
            </div>
          )}
        </GrowRelay>
      );
    },
    [editable, insertText, takeDraftWith, workspace],
  );

  const hasAlwaysActive = !editable && items.some((i) => i.alwaysActive);
  if (items.length === 0) return null;
  if (!editable && !hasAlwaysActive) return null;
  return (
    // `GrowRelay.Stop`: this Stack IS the row the actions sit in, so a grow ask
    // travelling up from one of them has arrived. Without it the ask would keep
    // going and grow some ancestor cell that has nothing to do with this strip.
    <GrowRelay.Stop>
      <Stack
        direction="row"
        align="center"
        gap="xs"
        // The density group's `padComposerActions`: `sm` sides and an `xs` foot
        // by default, the text box's own inset.
        className="p-composer-actions"
        onMouseDown={focusEditor}
      >
        {/* The editor's own "+": attach files, like a paste or a drop. */}
        {editable && <AttachFilesButton onError={onError} />}
        <PromptEditorSlots.FloatingAction.Render>
          {renderItem}
        </PromptEditorSlots.FloatingAction.Render>
      </Stack>
    </GrowRelay.Stop>
  );
}
