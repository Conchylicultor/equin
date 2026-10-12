import { useLiveRow } from "@plugins/network/plugins/live/web";
import { conversationHistory } from "@plugins/conversations/plugins/all-conversations/core";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import type { IdReferentState } from "@plugins/ids/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

/** A conversation is called by its own title, else its task's (a fresh one has none yet). */
function titleOf(row: { id: string; title: string | null; taskTitle: string }) {
  return row.title?.trim() || row.taskTitle.trim() || row.id;
}

/**
 * The conversation presenter's referent read: one point read of the
 * conversation history collection (every conversation, ended ones included).
 * A failed read keeps the row it last saw; with none, it is a failure — never
 * "missing", which nobody said.
 */
export function useConversationReferent(id: string): IdReferentState {
  const read = useLiveRow(conversationHistory, id);
  if (read.status === "loading") return { status: "loading" };
  if (read.status === "error") {
    return read.stale
      ? { status: "found", title: titleOf(read.stale) }
      : { status: "failed", error: read.error };
  }
  return read.found
    ? { status: "found", title: titleOf(read.row) }
    : { status: "missing" };
}

/** The link that toggles a conversation's column beside the surface holding its id. */
export function useConversationTarget(): (id: string) => LinkTarget {
  const opener = useConversationOpener();
  return (id) => opener.toggle(id);
}
