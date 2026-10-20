import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ContextRole } from "./slots";

/**
 * Before the agent first answers, a fold is the session's opening context;
 * after, it is something the harness re-sent mid-conversation.
 */
export type ContextFoldPhase = "session" | "update";

/**
 * One row of the rendered transcript. Indices point into the visible-event
 * array the items were built from, so every member keeps its own
 * `data-event-index`.
 */
export type TranscriptItem =
  | {
      kind: "event";
      index: number;
      /** The context run folded into this (host) event's row. */
      hosted?: readonly number[];
    }
  | { kind: "fold"; phase: ContextFoldPhase; members: readonly number[] };

const ASSISTANT_KINDS: ReadonlySet<JsonlEvent["kind"]> = new Set([
  "assistant-text",
  "assistant-thinking",
  "tool-call",
]);

function isFoldable(role: ContextRole | undefined): boolean {
  return role === "context" || role === "ambient";
}

/**
 * Folds runs of harness-injected context into transcript items.
 *
 * A run is a maximal stretch of consecutive events whose role is `context` or
 * `ambient`. A run directly after a host event folds into that host's row,
 * whatever its length or roles. Any other run holding a `context` event becomes
 * its own fold, even a single one, so harness context always reads as one
 * closed rule. A run of only `ambient` events stays as plain rows.
 *
 * A run never crosses a conversation event (a user prompt included), so the
 * per-prompt sections built on top of these items are unchanged.
 *
 * `answeredBefore`: `events` is a window that starts after the agent first
 * answered (older events are not loaded), so every fold in it is an update.
 */
export function groupContextRuns(
  events: readonly JsonlEvent[],
  roleOf: (event: JsonlEvent) => ContextRole | undefined,
  isHost: (event: JsonlEvent) => boolean,
  answeredBefore = false,
): TranscriptItem[] {
  const firstAssistant = events.findIndex((e) => ASSISTANT_KINDS.has(e.kind));
  const items: TranscriptItem[] = [];
  let i = 0;
  while (i < events.length) {
    if (!isFoldable(roleOf(events[i]!))) {
      items.push({ kind: "event", index: i });
      i++;
      continue;
    }
    const members: number[] = [];
    let hasContext = false;
    while (i < events.length) {
      const role = roleOf(events[i]!);
      if (!isFoldable(role)) break;
      if (role === "context") hasContext = true;
      members.push(i);
      i++;
    }
    const prev = items.at(-1);
    if (
      prev?.kind === "event" &&
      prev.hosted === undefined &&
      isHost(events[prev.index]!)
    ) {
      items[items.length - 1] = { ...prev, hosted: members };
    } else if (hasContext) {
      const phase =
        !answeredBefore &&
        (firstAssistant === -1 || members[0]! < firstAssistant)
          ? "session"
          : "update";
      items.push({ kind: "fold", phase, members });
    } else {
      for (const index of members) items.push({ kind: "event", index });
    }
  }
  return items;
}
