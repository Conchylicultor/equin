import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * One plugin's part of what an agent gets back after its context is compacted.
 *
 * A plugin that hands an agent something through a tool RESULT — and keeps a
 * record that it did — loses it at compaction: the summary folds the result
 * away, the record still says "delivered". `restore` is where it reconciles the
 * two: record what the agent no longer has, and return the text to hand back
 * (`""` for nothing). It runs once per compaction, before the agent's next turn.
 *
 * A part says how it may be sized, because the hook's output is capped by the
 * CLI (core/budget.ts):
 *
 * - `whole` — never cut (instructions the agent must follow). Every whole part
 *   is sent in full; when they outgrow the hook's cap, the agent still gets
 *   them in full, as a turn (`delivery-check`).
 * - `fit` — may be cut (a digest the agent can re-read with a tool). It is
 *   given the room the whole parts left and must return text no longer than
 *   that (`fitToBudget`); a longer answer fails the request.
 */
export type CompactionContextSource =
  | {
      /** Stable id, for logs and the docs. */
      id: string;
      size: "whole";
      restore(conversationId: string): Promise<string>;
    }
  | {
      id: string;
      size: "fit";
      restore(conversationId: string, budget: number): Promise<string>;
    };

export const CompactionContext =
  defineServerContribution<CompactionContextSource>(
    "conversations.compaction-context",
    { docLabel: (s) => `${s.id} (${s.size})` },
  );
