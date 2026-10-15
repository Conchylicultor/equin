import type { Registration } from "@plugins/framework/plugins/server-core/core";

// A question can be held OUTSIDE the pane: a PreToolUse hook that keeps the
// AskUserQuestion call open while the web shows it (the question-relay plugin).
// While it holds, no menu is on screen — the pane reads idle — so the status
// reconciler would never know a question is waiting. A hold source answers that
// question for it, and this file is the seam: the reconciler reads whatever
// sources are registered and names none of them.

/**
 * What a hold source says about a conversation's latest held question.
 *
 * - `open` — the question is held, unanswered; the pane shows no menu. The
 *   conversation is waiting on a question.
 * - `released` — the user chose to answer it in the terminal: the menu on
 *   screen (once drawn) is THAT question, so it must never be auto-flushed
 *   (auto-open would Escape exactly the menu the user asked for).
 *
 * Absent (no entry) — nothing held: the pane alone decides.
 */
export type QuestionHold = "open" | "released";

export interface QuestionHoldSource {
  /**
   * The hold of each of `ids` that has one. A pure read — the shadow audit
   * calls it every second — so a hold whose holder has died must already read
   * as absent here, without being written.
   */
  read(ids: readonly string[]): Promise<Map<string, QuestionHold>>;
  /**
   * Retire the holds of `ids` whose holder is gone (Escape killed the hook,
   * the agent or pane died). Called by the reconciler before it reads; the
   * write is the source's own.
   */
  reap(ids: readonly string[]): Promise<void>;
  /**
   * Hand the open holds of `ids` back to the CLI, which then draws its own
   * menu: the user is sending a message instead of answering, and that menu is
   * what the send dismisses (`submitTurn`, turns.ts). The write is the source's own; a
   * conversation with nothing open is left alone.
   */
  release(ids: readonly string[]): Promise<void>;
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

/**
 * Every source's holds for `ids`, merged: `open` wins over `released` (a held
 * question is waiting whatever another source remembers).
 */
export async function readQuestionHolds(
  ids: readonly string[],
): Promise<Map<string, QuestionHold>> {
  const merged = new Map<string, QuestionHold>();
  if (ids.length === 0) return merged;
  for (const source of sources) {
    for (const [id, hold] of await source.read(ids)) {
      if (merged.get(id) !== "open") merged.set(id, hold);
    }
  }
  return merged;
}

/** Retire dead holds in every source. */
export async function reapQuestionHolds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const source of sources) await source.reap(ids);
}

/** Hand every source's open holds of `ids` back to the CLI's own menu. */
export async function releaseQuestionHolds(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  for (const source of sources) await source.release(ids);
}
