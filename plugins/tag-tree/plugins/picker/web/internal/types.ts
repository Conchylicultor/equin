import type {
  CreateTagBody,
  CreateTagPathResult,
  MoveTagBody,
  TagRow,
  UpdateTagBody,
} from "@plugins/tag-tree/plugins/engine/core";

/** The writes a picker makes — a tree's `useTagTreeActions`, minus its pending flag. */
export interface TagPickerWrites {
  create(body: CreateTagBody): Promise<{ id: string }>;
  createPath(segments: readonly string[]): Promise<CreateTagPathResult>;
  update(id: string, body: UpdateTagBody): Promise<void>;
  move(id: string, dest: MoveTagBody): Promise<void>;
  remove(id: string): Promise<void>;
}

/** What a picker is asked: which tags are chosen, which may not be, and what a pick does. */
export interface TagPickerOptions {
  /** Ids currently chosen; the ✓ marks them. Single-tag carriers pass [id] or []. */
  selected: readonly string[];
  /**
   * Tags that cannot be picked. An excluded tag with a pickable descendant
   * stays as a dimmed, unpickable row; otherwise it is hidden.
   */
  exclude?: (tag: TagRow) => boolean;
  /** Rolled-up carrier counts (`rolledUpTagCounts`); absent → no count column. */
  counts?: ReadonlyMap<string, number>;
  /** Show "No tag" at the top while `selected` is non-empty (single-tag carriers). */
  offerNone?: boolean;
  /** A row was picked (or "No tag" → null). A created path picks its leaf. */
  onPick(tagId: string | null): void;
}
