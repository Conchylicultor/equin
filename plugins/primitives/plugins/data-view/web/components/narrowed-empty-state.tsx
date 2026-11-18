import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { dataPart } from "../../core";

/**
 * What a view says when it has no rows BECAUSE the search or the filter hid
 * them all — never the surface's own `emptyState`, which claims the data
 * itself is empty ("No prototypes yet") while rows exist behind the
 * narrowing. Names what narrows the view, with one button per narrowing to
 * take it off. Built by the body, so every view type draws it unchanged in
 * its own empty-state place.
 */
export function NarrowedEmptyState({
  query,
  filtered,
  onClearSearch,
  onClearFilter,
}: {
  /** The trimmed search query, `""` when none. */
  query: string;
  /** Whether the view's filter holds at least one complete rule. */
  filtered: boolean;
  onClearSearch: () => void;
  onClearFilter: () => void;
}): ReactNode {
  const searched = query !== "";
  const message = searched
    ? filtered
      ? `Nothing matches “${query}” with the current filter.`
      : `Nothing matches “${query}”.`
    : "Nothing matches the current filter.";
  return (
    <Stack align="center" gap="sm" {...dataPart("dv.narrowed-empty")}>
      <span>{message}</span>
      <Inline gap="sm" justify="center">
        {searched ? (
          <Button variant="outline" onClick={onClearSearch}>
            Clear search
          </Button>
        ) : null}
        {filtered ? (
          <Button variant="outline" onClick={onClearFilter}>
            Clear filter
          </Button>
        ) : null}
      </Inline>
    </Stack>
  );
}
