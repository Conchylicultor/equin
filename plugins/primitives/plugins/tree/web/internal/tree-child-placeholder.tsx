import type { ReactNode } from "react";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { moreLineId, type ChildPlaceholder } from "../../core";
import { TreeGuides } from "./tree-guides";
import { treeRowIndentStyle } from "./tree-indent";

/**
 * The placeholder child row: indented one level below its parent and aligned to
 * the label column (past the chevron slot), so it reads as the parent's content
 * rather than as a sibling. Same height invariant as `TreeRowChrome`. A paged
 * level's "Load more" line (after its loaded children) is one too: the
 * spinner while the level grows, Retry when the grow failed (the paging
 * footer's states, `InfiniteScrollFooter`), else the button.
 */
export function TreeChildPlaceholder({
  placeholder,
  depth,
  parentId,
  guides = false,
}: {
  placeholder: ChildPlaceholder;
  /** The depth of the CHILD row (parent depth + 1). */
  depth: number;
  /** The open node it stands under — a "Load more" line's focus id derives from it. */
  parentId: string;
  /** Draw the indent guides its sibling rows draw (`TreeModelArgs.guides`). */
  guides?: boolean;
}): ReactNode {
  const more = placeholder.kind === "more";
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      // The loading state carries its own `status` role.
      role={placeholder.kind === "failed" ? "alert" : undefined}
      data-tree-placeholder={placeholder.kind}
      // A "Load more" line is a keyboard stop (`treeKeyMove`): the arrow keys
      // reach it like a row, Enter grows the level. Focusable by script only —
      // its button is the tab stop.
      {...(more
        ? {
            "data-tree-row": true,
            "data-tree-id": moreLineId(parentId),
            tabIndex: -1,
          }
        : {})}
      // `relative`: the positioning context the guides are placed in.
      className="relative min-h-7 gap-tree-row px-xs py-xs text-body"
      // The same indent split and gap as `TreeRowChrome` — density tokens, so
      // a theme's wider step moves the placeholder (and its guides) with its
      // siblings.
      style={treeRowIndentStyle(depth)}
    >
      {guides && <TreeGuides depth={depth} />}
      {/* The chevron slot's width, so the text starts on the label column. */}
      <span className={`w-tree-chevron h-5 ${rigidClass()}`} aria-hidden />
      {placeholder.kind === "loading" ? (
        // The shared loading state (delayed, so a fast listing never flashes),
        // flush in the row: the row already owns the inset.
        <Loading
          variant="spinner"
          label="Loading…"
          className="px-none py-none"
        />
      ) : placeholder.kind === "empty" ? (
        <Text tone="faint">Empty</Text>
      ) : placeholder.kind === "more" ? (
        placeholder.growing ? (
          <Loading
            variant="spinner"
            label="Loading…"
            className="px-none py-none"
          />
        ) : placeholder.stalled ? (
          <>
            <Fill>
              <Text tone="destructive">Couldn't load more.</Text>
            </Fill>
            <Button
              variant="ghost"
              aspect="inline"
              onClick={placeholder.stalled.retry}
              className="px-2xs"
            >
              Retry
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            aspect="inline"
            onClick={placeholder.loadMore}
            className="px-2xs text-muted-foreground"
          >
            Load more
          </Button>
        )
      ) : (
        <>
          <Fill>
            <Text tone="destructive" title={placeholder.message}>
              {placeholder.message}
            </Text>
          </Fill>
          <Button
            variant="ghost"
            aspect="inline"
            onClick={placeholder.retry}
            className="px-2xs"
          >
            Retry
          </Button>
        </>
      )}
    </Stack>
  );
}
