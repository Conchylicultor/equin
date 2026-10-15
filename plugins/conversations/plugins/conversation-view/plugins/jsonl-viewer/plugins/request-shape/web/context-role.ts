import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";

/**
 * The request-shape row is harness context, not conversation: it folds with the
 * context the harness injected around it (`Session context` / `Context
 * update`) instead of standing between the prompt and that fold.
 */
export function requestShapeRole(e: JsonlEvent) {
  return e.kind === "request-shape" ? ("context" as const) : undefined;
}
