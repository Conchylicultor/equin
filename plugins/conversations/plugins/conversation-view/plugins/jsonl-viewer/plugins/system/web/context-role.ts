import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";

/**
 * A `System · informational` notice ("Compacted while idle…", "Usage limit
 * reached…") is ambient: it folds with the harness context it sits among, and
 * stays its own row anywhere else.
 */
export function informationalSystemRole(e: JsonlEvent) {
  return e.kind === "system" && e.subtype === "informational"
    ? ("ambient" as const)
    : undefined;
}
