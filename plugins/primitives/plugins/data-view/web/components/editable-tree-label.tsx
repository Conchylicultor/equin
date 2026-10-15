import { useEffect, useState, type ReactNode } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { TreeNode } from "@plugins/primitives/plugins/tree/core";
import {
  useRowControls,
  useTreeContext,
  type TreeItem,
} from "@plugins/primitives/plugins/tree/web";
import type { FieldDef } from "../../core";
import { useResolveCellEditor } from "../cell-editor-slot";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The editable primary-field label of a tree row — the tree view's
 * (`RowChrome`) and the nested table's first column alike: both publish the
 * row's controls, which it reads (`useRowControls`). Reuses the shared
 * `useResolveCellEditor()` capability (the same per-type editors the table
 * uses) instead of the table's click-to-edit `EditableCell`, because the tree
 * label doubles as the navigation target: it must keep **select-then-edit**
 * (a first click selects/navigates — via the row's own `onSelect`; a second
 * click on the already-selected row enters edit mode). New rows created via `onCreate` auto-open into edit via
 * the tree primitive's pending-focus → `shouldAutoFocus` signal.
 */
export function EditableTreeLabel<TNode extends TreeItem>(props: {
  node: TreeNode<TNode>;
  row: unknown;
  /** The primary field — guaranteed to have `onEdit`/`onEditValues` by the caller. */
  field: FieldDef<unknown>;
  /** The read-rendering of the primary value (caller passes resolveCell(...) ?? String). */
  read: ReactNode;
  className?: string;
}): ReactNode {
  const { node, row, field, read, className } = props;
  const resolveEditor = useResolveCellEditor();
  const { shouldAutoFocus, consumeAutoFocus } = useRowControls();
  const ctx = useTreeContext();
  const [editing, setEditing] = useState(false);
  const editingRef = useLatestRef(editing);

  // A freshly-created row auto-opens into edit mode; the slot editor autofocuses
  // its input on mount. `editing` is read via a latest-ref (not a dep) so the
  // effect doesn't re-fire when its own setEditing(true) flips `editing`.
  useEffect(() => {
    if (shouldAutoFocus && !editingRef.current) {
      setEditing(true);
      consumeAutoFocus();
    }
  }, [shouldAutoFocus, editingRef, consumeAutoFocus]);

  if (editing) {
    const value = field.value?.(row);
    const values = field.values?.(row);
    const editor = resolveEditor({
      field,
      value,
      values,
      raw: row,
      onCommit: (next) => {
        setEditing(false);
        void field.onEdit?.(row, next);
      },
      onCommitValues: (next) => {
        setEditing(false);
        void field.onEditValues?.(row, next);
      },
      onCancel: () => setEditing(false),
    });
    // Only render the editor when a per-type editor exists; otherwise fall
    // through to the read label below.
    if (editor !== undefined) {
      return (
        <span
          // eslint-disable-next-line layout/no-adhoc-layout -- flexible editor leaf, a row-level flex child of TreeRowChrome's flex row (it owns the row layout)
          className={cn("min-w-0 flex-1", className)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {editor}
        </span>
      );
    }
  }

  return (
    <span
      // eslint-disable-next-line layout/no-adhoc-layout -- flexible truncating label, a row-level flex child of TreeRowChrome's flex row (it owns the row layout)
      className={cn("min-w-0 flex-1 truncate", className)}
      // Selection happens on CLICK, never on press: the whole row is the drag
      // source, and selecting on mousedown navigated before dnd-kit's
      // activation distance was reached — the page opened and the drag never
      // started. A click on an unselected row bubbles to TreeRowChrome's
      // `onSelect`; dnd-kit swallows the click that ends a real drag.
      onClick={(e) => {
        // Clicking the label of an already-selected row enters edit mode.
        if (ctx.selectedId === node.id) {
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {read}
    </span>
  );
}
