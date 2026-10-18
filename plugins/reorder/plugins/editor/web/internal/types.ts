import type { ReactNode } from "react";
import type { ReorderEntry } from "@plugins/reorder/plugins/area/web";

export interface ReorderEditorProps {
  /** Top-level display order (items + pre-rendered nodes). */
  entries: readonly ReorderEntry[];
  /** Hidden items, surfaced in the restore popover. */
  hiddenItems: Array<{ key: string; label: string }>;

  // --- core callbacks (always present) ---
  onDrop: (draggedId: string, overId: string) => void;
  onHide: (id: string) => void;
  onRestore: (key: string) => void;
  /** Registry-driven insert affordances (e.g. "Add Spacer"), shown in the
   *  RestoreButton popover. The `create()` half is consumer-side; `onInsert`
   *  is opaque to the editor. */
  inserts: Array<{ label: string; onInsert: () => void }>;
  /** Generic remove for a node by id (e.g. the spacer's × button). */
  onRemoveNode: (id: string) => void;

  // --- display ---
  editMode: boolean;
  orientation?: "horizontal" | "vertical";
  /** Active-drag overlay (e.g. a floating contribution card). Omit → no overlay. */
  renderOverlay?: (activeId: string) => ReactNode;
}
