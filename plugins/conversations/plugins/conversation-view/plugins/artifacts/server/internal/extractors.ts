import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { KindExtractor } from "../../core";

/**
 * A kind's server half: its pure extractor over transcript events, run by the
 * host over the whole transcript. The kind's presentation (label, icon,
 * section) is its web `ConversationArtifacts.Kind` contribution under the same
 * `id`.
 */
export const ConversationArtifactExtractor =
  defineServerContribution<KindExtractor>("conversations.artifacts.extractor", {
    docLabel: (kind) => kind.id,
  });
