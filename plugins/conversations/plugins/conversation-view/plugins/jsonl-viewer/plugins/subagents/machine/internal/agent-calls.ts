import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { AGENT_TOOL_NAME } from "../../core";
import {
  readChainLines,
  resolveConversationTranscriptPaths,
  transcriptChainSignature,
} from "@plugins/conversations/plugins/transcript-watcher/server";

/**
 * Which name each `Agent` call in a conversation asked for — the half of the
 * join that lives in the PARENT transcript.
 *
 * A sub-agent spawned with a name is recorded as an in-process teammate and its
 * meta file carries no `toolUseId`, so the only thing tying it to the card on
 * screen is the name, and the card's side of that is the `name` in its own
 * `Agent` call's input. A surface rendering the card already holds that event
 * and can pass it straight to `describedSubagent`; the `subagent-transcript`
 * resource cannot, because a resource is handed only a tool-use id — so it
 * reads it back from here.
 *
 * **Raw lines, not built events.** `readChainLines` parses one JSON object per
 * line and stops; `readJsonlEventsFromChain` would additionally pair tool
 * results, unwrap relay envelopes, decode attachments and run an XML parser over
 * every user turn. We want six characters out of a tool-use block.
 *
 * Memoized on the parent chain's own signature, so the multi-megabyte read
 * happens once per parent write rather than once per sub-agent append — and the
 * signature is a faithful function of what the compute reads, which is what lets
 * a name that appears later invalidate the index instead of being missed.
 *
 * Only the parent chain is scanned. A sub-agent that itself spawned a named
 * teammate has its `Agent` call inside the SUB-AGENT's transcript, and those are
 * the files that grow constantly — folding them in would trade this bound away
 * for 5 of 818 sub-agents. Such a teammate stays unreachable from a pane opened
 * by CALL id, which is a state the result type can express. A surface holding
 * the row opens it by its own agent id instead (`findSubagentByAgentId`), and a
 * nested card rendered inside its parent's own pane still joins, because that
 * surface holds the event and passes the name directly.
 */
const memo = createSignedMemo<Map<string, string>>({
  name: "subagent-agent-call-names",
  signature: async (conversationId) =>
    transcriptChainSignature(
      await resolveConversationTranscriptPaths(conversationId),
    ),
  compute: async (conversationId) =>
    scanAgentCallNames(
      await resolveConversationTranscriptPaths(conversationId),
    ),
});

/** tool-use id → the `name` that `Agent` call requested, for every call that named one. */
export async function agentCallNames(
  conversationId: string,
): Promise<Map<string, string>> {
  return memo.get(conversationId);
}

export function evictAgentCallNames(conversationId: string): void {
  memo.evict(conversationId);
}

/** The name a specific `Agent` call requested, or `undefined` if it named none. */
export async function requestedNameFor(
  conversationId: string,
  toolUseId: string,
): Promise<string | undefined> {
  return (await agentCallNames(conversationId)).get(toolUseId);
}

export async function scanAgentCallNames(
  paths: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const line of await readChainLines(paths)) {
    const message = line.message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || b.name !== AGENT_TOOL_NAME) continue;
      const input = b.input;
      if (
        typeof b.id !== "string" ||
        typeof input !== "object" ||
        input === null
      )
        continue;
      const requested = (input as Record<string, unknown>).name;
      if (typeof requested === "string" && requested !== "") {
        names.set(b.id, requested);
      }
    }
  }
  return names;
}
