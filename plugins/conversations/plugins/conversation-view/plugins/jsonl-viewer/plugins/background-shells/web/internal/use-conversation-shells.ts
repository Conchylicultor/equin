import {
  useLive,
  mapRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  combineResources,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  ResourceError,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/core";
import { useConversationById } from "@plugins/conversations/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import {
  conversationShellFacts,
  shellOutput,
  shellsFromFacts,
  type BackgroundShell,
  type ShellOutput,
} from "../../core";

/**
 * Every background shell of one conversation.
 *
 * `pending` until BOTH the transcript and the conversation row have arrived:
 * a shell's end lives in the transcript, and its liveness fallback in the
 * conversation's status, so folding either half-arrived would report a
 * finished shell as running — a claim about the user's work that then
 * reverses itself.
 */
export type ConversationShells =
  | { kind: "pending" }
  /** A read behind the set FAILED — render it with Retry, never as a spinner or an empty set. */
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | {
      kind: "known";
      /** Every background shell, in start order (`backgroundShellsOf`). */
      shells: BackgroundShell[];
    };

/**
 * The conversation's background shells — the one read the band, the `Bash`
 * card and the output pane all derive from. `useLive` shares one query per
 * params, so every caller in a conversation costs the one `jsonl-events`
 * subscription the transcript already holds.
 */
export function useConversationShells(
  conversationId: string | null,
): ConversationShells {
  const params = conversationId === null ? null : { id: conversationId };
  const facts = useLive(conversationShellFacts, params);
  const status = conversationStatusOf(useConversationById(conversationId));

  // Gate FIRST, derive after — nothing below may run on a half-arrived read.
  const reads = combineResources({ events: facts, status });
  if (reads.status === "error") {
    return { kind: "failed", error: reads.error, refetch: reads.refetch };
  }
  if (reads.status === "loading") {
    return { kind: "pending" };
  }
  return {
    kind: "known",
    shells: shellsFromFacts(reads.data.events, reads.data.status),
  };
}

/**
 * The live tail of one shell's output file. The server resolves the file from
 * the conversation's own transcript; this names only the shell. A band row
 * and the open pane on the same shell share one subscription. `unavailable`
 * where no computer is behind the page: the file is on the desktop's disk.
 */
export function useShellOutput(
  conversationId: string | null,
  shellId: string,
): ResourceResult<ShellOutput> | ResourceUnavailable {
  return useLive(
    shellOutput,
    conversationId === null ? null : { id: conversationId, shellId },
  );
}

/**
 * The conversation's status as the fold reads it: a deleted conversation (no
 * row) runs no process, so it reads as gone. A failed read fails the set,
 * with Retry, as a failed transcript read does — never a stand-in status.
 */
function conversationStatusOf(
  row: LiveRowResult<ConversationEntry>,
): ResourceResult<ConversationEntry["status"]> {
  return mapRow(row, (r) => r?.status ?? "gone");
}
