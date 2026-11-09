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
export interface TagPickerOptions<Row extends TagRow = TagRow> {
  /** Ids currently chosen; the ✓ marks them. Single-tag carriers pass [id] or []. */
  selected: readonly string[];
  /**
   * Tags that cannot be picked. An excluded tag with a pickable descendant
   * stays as a dimmed, unpickable row; otherwise it is hidden.
   */
  exclude?: (tag: Row) => boolean;
  /** Rolled-up carrier counts (`rolledUpTagCounts`); absent → no count column. */
  counts?: ReadonlyMap<string, number>;
  /**
   * Ids picked as NOT (a filter's exclusions): struck through in the
   * destructive tone. A click on one picks it like any other row.
   */
  negated?: readonly string[];
  /**
   * How a picked row is marked: a trailing ✓ (`check`, the default — a
   * carrier's tags), or a leading box (`checkbox` — a filter: ✓ picked, −
   * negated, a dashed − when a tag under it is either).
   */
  indicator?: "check" | "checkbox";
  /** Which tags open unfolded: every one (default), or the roots alone. */
  defaultExpanded?: "all" | "roots";
  /** Focus the search on mount (default true — a popover's). */
  autoFocus?: boolean;
  /**
   * Whether a path created from the search is picked (default true). A
   * filter passes false: a new tag carries nothing, so picking it would
   * filter everything out.
   */
  pickCreated?: boolean;
  /**
   * Whether the ⋯ menu offers Delete for a tag (default every tag). The
   * tree's server-side `refuseDelete` still decides; this only hides it.
   */
  canDelete?: (tag: Row) => boolean;
  /** Show "No tag" at the top while `selected` is non-empty (single-tag carriers). */
  offerNone?: boolean;
  /** A row was picked (or "No tag" → null). A created path picks its leaf. */
  onPick(tagId: string | null): void;
}
