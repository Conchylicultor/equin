import { useCallback, useState } from "react";
import type {
  SnippetDraft,
  SnippetEditorProps,
} from "../components/snippet-editor";

/** A named prompt snippet as a list stores it. */
export interface Snippet {
  id: string;
  title: string;
  prompt: string;
}

/** Which snippet editor is open, if any. */
export type SnippetEditing =
  | { kind: "none" }
  | { kind: "new"; prompt: string }
  | { kind: "edit"; id: string };

export interface SnippetListEditOptions<T extends Snippet> {
  /** The list in its authored order — what an edit rewrites. */
  items: readonly T[];
  /**
   * Store the changed list. Answers whether it was taken: on `false` (refused,
   * and said so) the editor stays open with what was typed.
   */
  onChange: (next: T[]) => boolean;
  /**
   * A new item from its draft and fresh id — the host knows what its items
   * carry beyond a name and a prompt, and their defaults.
   */
  create: (d: SnippetDraft & { id: string }) => T;
  /** Called once a new item is stored (a picker selects it). */
  onAdded?: (item: T) => void;
  /** Called once an item is deleted (a picker drops it if it was selected). */
  onRemoved?: (id: string) => void;
}

/** The open editor: its props (minus the host's `noun`), and a `key` that resets it per target. */
export interface OpenSnippetEditor {
  key: string;
  props: Omit<SnippetEditorProps, "noun">;
}

export interface SnippetListEdit {
  editing: SnippetEditing;
  /** Open the editor on a new snippet, its prompt prefilled (e.g. the draft). */
  startNew: (prompt?: string) => void;
  /** Open the editor on one existing snippet. */
  startEdit: (id: string) => void;
  close: () => void;
  /** The open editor's props, or `null` while none is open. */
  editor: OpenSnippetEditor | null;
}

/**
 * Add / rename / rewrite / delete over a list of named prompt snippets, edited
 * in place: which editor is open, and the list rewritten from what it hands
 * back. A new snippet is appended last — the authored order is a ranking's
 * never-used tie-break, so it sits after the ones already there. The host
 * places the editor (`<SnippetEditor key={editor.key} {...editor.props} noun=… />`) where its list
 * draws the row being edited.
 */
export function useSnippetListEdit<T extends Snippet>({
  items,
  onChange,
  create,
  onAdded,
  onRemoved,
}: SnippetListEditOptions<T>): SnippetListEdit {
  const [editing, setEditing] = useState<SnippetEditing>({ kind: "none" });
  const close = useCallback(() => setEditing({ kind: "none" }), []);
  const startNew = useCallback(
    (prompt = "") => setEditing({ kind: "new", prompt: prompt.trim() }),
    [],
  );
  const startEdit = useCallback(
    (id: string) => setEditing({ kind: "edit", id }),
    [],
  );

  let editor: OpenSnippetEditor | null = null;
  if (editing.kind === "new") {
    editor = {
      key: "new",
      props: {
        mode: "new",
        initial: { title: "", prompt: editing.prompt },
        onSave: (d) => {
          const item = create({ id: crypto.randomUUID(), ...d });
          if (!onChange([...items, item])) return;
          close();
          onAdded?.(item);
        },
        onClose: close,
      },
    };
  } else if (editing.kind === "edit") {
    const { id } = editing;
    const current = items.find((t) => t.id === id);
    // Deleted elsewhere while open (Settings, another tab): nothing to edit.
    if (current) {
      editor = {
        key: id,
        props: {
          mode: "edit",
          initial: { title: current.title, prompt: current.prompt },
          onSave: (d) => {
            if (onChange(items.map((t) => (t.id === id ? { ...t, ...d } : t))))
              close();
          },
          onDelete: () => {
            if (!onChange(items.filter((t) => t.id !== id))) return;
            close();
            onRemoved?.(id);
          },
          onClose: close,
        },
      };
    }
  }

  return { editing, startNew, startEdit, close, editor };
}
