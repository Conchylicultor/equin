import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import {
  baIdKind,
  BEFORE_AFTER_ARTIFACT_KIND,
  extractBeforeAfterHits,
} from "../core";
import {
  beforeAfterAttachmentLinkContributions,
  beforeAfterPairsServed,
} from "./internal/resources";

export {
  registerBeforeAfterPair,
  resolveBeforeAfterReferent,
} from "./internal/pairs";
export type { NewBeforeAfterPair } from "./internal/pairs";
// The served pairs.
export { beforeAfterPairsServed } from "./internal/resources";
// The pairs table, for a lookup-only read of some of its columns (the id
// chip's referent rows: id and title).
export { _beforeAfterPairs } from "./internal/tables";

export default {
  description:
    "Before / after pairs, portable half: the ba id kind, the before_after_pairs table served as the before-after.pairs live collection (by conversation newest first, by tool call, by id), its two PNGs kept as attachments linked to the row, and the Before / after artifact extractor (one per register_before_after call, keyed by its tool-use id).",
  contributions: [
    IdKinds.Kind({ kind: baIdKind }),
    ...beforeAfterPairsServed.declare,
    ...beforeAfterAttachmentLinkContributions,
    // Something the conversation made — counted on the Artifacts button.
    ConversationArtifactExtractor({
      id: BEFORE_AFTER_ARTIFACT_KIND,
      origin: "produced",
      extract: extractBeforeAfterHits,
    }),
  ],
} satisfies ServerPluginDefinition;
