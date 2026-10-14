import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { PageRow } from "@plugins/page/plugins/editor/core";
import { TagDot, usePageTagIndex } from "@plugins/page/plugins/tags/web";

/** Dots a row shows at most; a page with more still lists them all on hover. */
const MAX_DOTS = 3;

/**
 * The sidebar row's mark (`PageTree.RowMarker`): one small dot per tag in the
 * tag's hue, the names on hover. Nothing for an untagged page — and nothing
 * while the tags load: a missing dot claims nothing, it appears once known.
 */
export function TagDotsMarker({ page }: { page: PageRow }) {
  const tags = foldResource(usePageTagIndex(), {
    loading: () => undefined,
    error: (_error, stale) => stale?.get(page.id),
    ready: (map) => map.get(page.id),
  });
  if (tags === undefined || tags.length === 0) return null;
  return (
    <Inline gap="2xs" title={tags.map((t) => t.name).join(", ")}>
      {tags.slice(0, MAX_DOTS).map((t) => (
        <TagDot key={t.id} color={t.color} className="size-1.5" />
      ))}
    </Inline>
  );
}
