import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { PageReference } from "@plugins/page/plugins/page-reference/web";
import { pageTagIdKind } from "../core";
import { PageTagChips } from "./components/page-tag-chips";
import { tagsPresentation } from "./internal/presentation";

export { TagChipRow } from "./components/page-tag-chips";
export { TagDot } from "./components/tag-chip";
export { TagPicker } from "./components/tag-picker";
export {
  usePageTagIndex,
  usePageTags,
  usePageTagsEditor,
  type PageTagsEditor,
} from "./internal/hooks";

export default {
  description:
    "Page tags, web half: the vocabulary and per-page reads (usePageTags, usePageTagIndex, the optimistic usePageTagsEditor), the soft TagChip / TagDot, the read-only PageTagChips, and the TagPicker popover (search or create, toggle, and per-tag rename / recolor / delete). Shows a page's tags after its title on every page reference (sub-page rows, link blocks, backlinks), and presents the exposed `tags` field (options read live from the vocabulary) in every list whose rows are blocks.",
  contributions: [
    IdKinds.Kind({ kind: pageTagIdKind }),
    PageReference.Trailing({ id: "tags", component: PageTagChips }),
    tagsPresentation,
  ],
} satisfies PluginDefinition;
