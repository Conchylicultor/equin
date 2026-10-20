import type { TranscriptSourceImpl } from "@plugins/conversations/plugins/transcript-source/server";
import { resolveConversationTranscriptPaths } from "../../server/internal/resolve-chain";
import { transcriptChainSignature } from "../../server/internal/chain-signature";
import { readJsonlEventsFromChain } from "../../server/internal/parse-jsonl";
import { watchTranscript } from "../../server/internal/watcher";

/**
 * The desktop's transcripts: Claude Code's session files on disk. Both halves
 * resolve the chain first, the signature being the chain's per-file (path,
 * mtime, size) — a faithful function of every input the read parses, so a
 * value ETagged by it can never be served stale. The watch is the single
 * transcript watcher, which reads the chain once and hands the events and the
 * signature they were read under as one pair.
 */
export const diskTranscripts: TranscriptSourceImpl = {
  signature: async (id) =>
    transcriptChainSignature(await resolveConversationTranscriptPaths(id)),
  events: async (id) =>
    readJsonlEventsFromChain(await resolveConversationTranscriptPaths(id)),
  watch: watchTranscript,
};
