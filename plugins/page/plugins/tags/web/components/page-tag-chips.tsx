import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { PageTagRow } from "../../core";
import { usePageTags } from "../internal/hooks";
import { TagChip } from "./tag-chip";

/**
 * A page's tags as a read-only row of chips, in the page's order — or nothing
 * at all for a page with none. Nothing while the tags are still loading too: a
 * chip strip is an enrichment of the row it sits in, and no chip is the one
 * answer that claims nothing about the page (the chips pop in once known). A
 * failed read keeps the last tags it knew; the read failure itself is reported
 * by live-state's own error surface, not repeated on every row.
 */
export function PageTagChips({ pageId }: { pageId: string }) {
  const tags = foldResource(usePageTags(pageId), {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (data) => data,
  });
  if (tags === null || tags.length === 0) return null;
  return <TagChipRow tags={tags} />;
}

/** Chips in one line, rigid: they never wrap, the label beside them truncates. */
export function TagChipRow({ tags }: { tags: readonly PageTagRow[] }) {
  return (
    <Inline gap="xs" className={rigidClass()}>
      {tags.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
    </Inline>
  );
}
