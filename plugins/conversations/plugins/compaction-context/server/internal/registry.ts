import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * One plugin's part of what an agent gets back after its context is compacted.
 *
 * A plugin that hands an agent something through a tool RESULT — and keeps a
 * record that it did — loses it at compaction: the summary folds the result
 * away, the record still says "delivered". `restore` is where it reconciles the
 * two: record what the agent no longer has, and return the text to hand back
 * (`""` for nothing). It runs once per compaction, before the agent's next turn.
 */
export interface CompactionContextSource {
  /** Stable id, for logs and the docs. */
  id: string;
  restore(conversationId: string): Promise<string>;
}

export const CompactionContext =
  defineServerContribution<CompactionContextSource>(
    "conversations.compaction-context",
    { docLabel: (s) => s.id },
  );
