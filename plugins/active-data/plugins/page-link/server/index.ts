import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { blockIdKind } from "@plugins/page/plugins/editor/core";
import { BLOCK_CHIP_SURFACES } from "../core";
import { resolveBlockReferent } from "./internal/referent";

export default {
  description:
    "The block id chip's server half (idChipServer): resolves a bare `block-<id>` to what its chip shows — the page's title, or '<page title> › <block type>' for a content block — for the id registry and for model-read text. Transcript-only, so no page-editor token.",
  contributions: [
    ...idChipServer({
      kind: blockIdKind,
      surfaces: BLOCK_CHIP_SURFACES,
      resolve: resolveBlockReferent,
      // The tag a model has always read a block id as: it resolves to its page.
      referentTag: "page",
    }),
  ],
} satisfies ServerPluginDefinition;
