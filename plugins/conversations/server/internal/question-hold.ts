import type { Registration } from "@plugins/framework/plugins/server-core/core";

// A question is held by whatever parks the AskUserQuestion call (the
// question-relay plugin, fed by the sdk runtime's `canUseTool`). A hold source
// tells the status reconciler a question is waiting, and this file is the
// seam: the reconciler reads whatever sources are registered and names none of
// them.

/**
 * What a hold source says about a conversation's latest held question.
 *
 * - `open` — the question is held, unanswered: the conversation is waiting on
 *   a question.
 *
 * Absent (no entry) — nothing held.
 */
export type QuestionHold = "open";

export interface QuestionHoldSource {
  /**
   * The hold of each of `ids` that has one. A pure read, so a hold whose
   * holder has died must already read as absent here, without being written.
   */
  read(ids: readonly string[]): Promise<Map<string, QuestionHold>>;
  /**
   * Retire the holds of `ids` whose holder is gone (the agent died). Called by
   * the reconciler before it reads; the write is the source's own.
   */
  reap(ids: readonly string[]): Promise<void>;
}

const sources = new Set<QuestionHoldSource>();

export const QuestionHolds = {
  /** A {@link Registration} adding `source` when the framework registers it. */
  define(source: QuestionHoldSource): Registration {
    return {
      register() {
        sources.add(source);
      },
    };
  },
};

/** Every source's holds for `ids`, merged. */
export async function readQuestionHolds(
  ids: readonly string[],
): Promise<Map<string, QuestionHold>> {
  const merged = new Map<string, QuestionHold>();
  if (ids.length === 0) return merged;
  for (const source of sources) {
    for (const [id, hold] of await source.read(ids)) merged.set(id, hold);
  }
  return merged;
}

/** Retire dead holds in every source. */
export async function reapQuestionHolds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const source of sources) await source.reap(ids);
}
