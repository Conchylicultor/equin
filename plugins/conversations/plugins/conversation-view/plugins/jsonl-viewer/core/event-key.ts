import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * A transcript row's **content identity** — stable across filtering, chain
 * refreshes and re-renders, unlike its position in any particular array.
 *
 * Why this exists rather than reusing the array index: `data-event-index` is
 * stamped over `visibleEvents`, the array *after* every `JsonlViewer.EventFilter`
 * contribution has run, so index `n` names a different row the moment a filter
 * appears, disappears, or resolves late during boot. A chain refresh that
 * prepends an earlier session's lines shifts every index too. Anything that
 * remembers a row across time (scroll restoration, the table of contents) must
 * key on identity instead.
 *
 * `toolUseId` is Claude's own id and is already this row's React key. Everything
 * else falls back to `kind:at` — the timestamp is per-line in the JSONL, so
 * collisions need two events of the same kind written in the same millisecond.
 * A collision resolves to a neighbouring row, which is a cosmetic miss for both
 * consumers, not a correctness failure.
 */
export function eventKey(event: JsonlEvent): string {
  if (event.kind === "tool-call") return `tool:${event.toolUseId}`;
  if (event.kind === "task-notification" && event.toolUseId) {
    return `tool:${event.toolUseId}`;
  }
  return `${event.kind}:${event.at}`;
}
