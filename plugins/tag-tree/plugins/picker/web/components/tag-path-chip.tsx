import type { ComponentProps, ReactNode } from "react";
import {
  tagPath,
  type TagRow,
  type TagTree,
} from "@plugins/tag-tree/plugins/engine/core";
import { useTagTree } from "@plugins/tag-tree/plugins/engine/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { TagMark } from "./tag-mark";

const addIcon = symbol("add");
const caretIcon = symbol("expand-more");

export type TagPathChipProps<Row extends TagRow = TagRow> = Omit<
  ComponentProps<"button">,
  "children"
> & {
  tree: TagTree<Row>;
  /** The carrier's tag, or null when it has none. */
  tagId: string | null;
};

/**
 * A carrier's one tag as a header chip — the trigger of its
 * `TagPickerPopover`: the tag's dot and path (past two levels collapsed to
 * `first / … / leaf`, ancestors muted) and a caret; untagged, a dashed
 * `＋ Tag`. Ringed in the accent while its popover is open. Every other prop
 * lands on the button (the popover's trigger wiring).
 */
export function TagPathChip<Row extends TagRow>({
  tree,
  ...props
}: TagPathChipProps<Row>): ReactNode {
  const result = useTagTree(tree);
  return (
    <TagPathChipView
      tags={result.status === "ready" ? result.data : undefined}
      {...props}
    />
  );
}

/**
 * {@link TagPathChip} over rows already in hand — `tags` undefined while the
 * tree is not known yet (a tagged chip then shows its pending state).
 */
export function TagPathChipView({
  tags,
  tagId,
  className,
  ...button
}: Omit<TagPathChipProps, "tree"> & {
  tags: readonly TagRow[] | undefined;
}): ReactNode {
  const path = tagId !== null && tags ? tagPath(tagId, tags) : [];
  // A tag that is not (or no longer) in the tree reads as untagged once the
  // tree is known — a delete's carrier rewrite lands a moment later.
  const empty = tagId === null || (tags !== undefined && path.length === 0);
  return (
    <Line
      as="button"
      type="button"
      className={cn(
        "h-7 gap-xs rounded-full border px-sm",
        "hover:border-primary/60 data-popup-open:border-primary data-popup-open:ring-2 data-popup-open:ring-primary/25",
        empty
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-muted/40",
        className,
      )}
      {...button}
    >
      {empty ? (
        <>
          <Icon icon={addIcon} className="size-4" />
          <Text variant="tag">Tag</Text>
        </>
      ) : tags === undefined ? (
        <Loading variant="text" label="Tag" />
      ) : (
        <>
          <TagMark tag={path.at(-1)!} tags={tags} />
          <Text variant="tag">
            <PathWords path={path} />
          </Text>
          <Icon icon={caretIcon} className="size-4 text-faint-foreground" />
        </>
      )}
    </Line>
  );
}

/** The path's words: past two levels, `first / … / leaf`; every ancestor muted. */
function PathWords({ path }: { path: readonly TagRow[] }) {
  const shown: (TagRow | null)[] =
    path.length > 2 ? [path[0]!, null, path.at(-1)!] : [...path];
  return (
    <>
      {shown.map((t, i) => (
        <span key={t?.id ?? "…"}>
          {i > 0 ? <span className="text-faint-foreground"> / </span> : null}
          {t === null ? (
            <span className="text-faint-foreground">…</span>
          ) : (
            <span
              className={
                i < shown.length - 1 ? "text-muted-foreground" : undefined
              }
            >
              {t.name}
            </span>
          )}
        </span>
      ))}
    </>
  );
}
