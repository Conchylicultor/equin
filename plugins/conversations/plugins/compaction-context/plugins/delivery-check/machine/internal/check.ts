import { getConversationRow, submitTurn } from "@plugins/conversations/server";
import {
  onCompactionContextSent,
  pendingSends,
  settleSend,
  type CompactionContextSend,
} from "@plugins/conversations/plugins/compaction-context/server";
import {
  onSessionTranscriptWritten,
  readChainLines,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { fallbackTurnText } from "./fallback";
import type { CompactionContextCutPayload } from "./report-kind";
import { judgeDelivery } from "./verdict";

/**
 * Every compaction context handed out and not yet judged, by conversation, with
 * the session id whose transcript will show what the agent got. Loaded from
 * compaction_context_sends at boot (a send survives a restart), added to by the
 * endpoint's in-process signal, emptied as each is judged.
 */
const pending = new Map<
  string,
  { send: CompactionContextSend; sessionId: string | null }
>();
/** Conversations being judged now, and those written to meanwhile. */
const judging = new Set<string>();
const rejudge = new Set<string>();

let unsubscribes: (() => void)[] = [];

async function track(send: CompactionContextSend): Promise<void> {
  const row = await getConversationRow(send.conversationId);
  if (row === null) {
    // No such conversation here: nothing will ever show what it got.
    await settleSend(send);
    return;
  }
  pending.set(send.conversationId, { send, sessionId: row.claudeSessionId });
}

async function judge(conversationId: string, file: string): Promise<void> {
  if (judging.has(conversationId)) {
    rejudge.add(conversationId);
    return;
  }
  judging.add(conversationId);
  try {
    do {
      rejudge.delete(conversationId);
      const entry = pending.get(conversationId);
      if (entry === undefined) return;
      const verdict = judgeDelivery(await readChainLines([file]), entry.send);
      if (verdict.kind === "pending") continue;
      pending.delete(conversationId);
      if (verdict.kind === "cut") await onCut(entry.send, verdict);
      await settleSend(entry.send);
    } while (rejudge.has(conversationId));
  } finally {
    judging.delete(conversationId);
  }
}

async function onCut(
  send: CompactionContextSend,
  verdict: {
    received: CompactionContextCutPayload["received"];
    receivedChars: number;
  },
): Promise<void> {
  const text = fallbackTurnText(send.context);
  const out = await submitTurn(send.conversationId, {
    kind: "event",
    text,
    typedText: text,
  });
  const data: CompactionContextCutPayload = {
    conversationId: send.conversationId,
    sentChars: send.context.length,
    received: verdict.received,
    receivedChars: verdict.receivedChars,
    turn: out.kind,
  };
  await recordReport({
    kind: "compaction-context-cut",
    source: "server-compaction-context",
    data,
    message:
      `${send.conversationId}: the compaction context (${send.context.length} chars) ` +
      `was cut by the Claude CLI (${verdict.received}); ` +
      (out.kind === "submitted"
        ? "sent in full as a turn"
        : `the turn carrying it was not delivered (${out.kind})`),
  });
}

/** Start judging: reload what was pending, then follow sends and transcript writes. */
export async function startDeliveryCheck(): Promise<void> {
  unsubscribes = [
    onCompactionContextSent((send) => {
      void track(send);
    }),
    onSessionTranscriptWritten((written) => {
      if (pending.size === 0) return;
      for (const [conversationId, { sessionId }] of pending) {
        const file = sessionId === null ? undefined : written.get(sessionId);
        if (file !== undefined) void judge(conversationId, file);
      }
    }),
  ];
  for (const send of await pendingSends()) await track(send);
}

export function stopDeliveryCheck(): void {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
}
