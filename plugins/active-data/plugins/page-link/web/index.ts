import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { BLOCK_CHIP_SURFACES } from "../core";
import {
  PageLinkChip,
  useBlockReferent,
  useBlockTargetById,
} from "./components/page-link-chip";

export { PageLinkChip };

export default {
  description:
    "Renders raw `block-<id>` strings inline as clickable chips that open what the id names: a page id opens the page-detail pane, a content-block id opens the block-detail pane (that block as a page of its own). Transcript only. Presents the block id kind to the id registry. Models emit the bare id, no tag wrapping needed.",
  contributions: [
    ...idChip({
      presenter: {
        kind: blockIdKind,
        useReferent: useBlockReferent,
        useTarget: useBlockTargetById,
      },
      surfaces: BLOCK_CHIP_SURFACES,
      component: PageLinkChip,
    }),
  ],
} satisfies PluginDefinition;
