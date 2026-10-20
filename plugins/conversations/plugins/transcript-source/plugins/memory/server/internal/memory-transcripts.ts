import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  buildJsonlEvents,
  mergeChainLines,
  type TranscriptSnapshot,
  type TranscriptSourceImpl,
} from "@plugins/conversations/plugins/transcript-source/server";

// Each conversation's transcript as Claude Code JSONL text, with a version that
// moves on every write — the signature. Lost with the process.
const transcripts = new Map<string, { jsonl: string; version: number }>();
const watchers = new Map<string, Set<(snapshot: TranscriptSnapshot) => void>>();

// No files beside the transcript, so a prompt's referenced image is never here:
// it renders as the path it names.
const noImages = async (): Promise<null> => null;

function parse(jsonl: string): Promise<JsonlEvent[]> {
  return buildJsonlEvents(
    mergeChainLines([{ path: "memory", raw: jsonl }]),
    noImages,
  );
}

const signatureOf = (id: string): string =>
  `memory:${transcripts.get(id)?.version ?? 0}`;

export const memoryTranscripts: TranscriptSourceImpl = {
  signature: async (id) => signatureOf(id),
  events: async (id) => parse(transcripts.get(id)?.jsonl ?? ""),
  watch: (id, onChange) => {
    const set = watchers.get(id) ?? new Set();
    watchers.set(id, set);
    set.add(onChange);
    return () => {
      set.delete(onChange);
      if (set.size === 0) watchers.delete(id);
    };
  },
};

/**
 * Write a conversation's whole transcript — Claude Code JSONL, one record per
 * line — replacing what it had, and tell its watchers.
 */
export async function writeTranscript(
  conversationId: string,
  jsonl: string,
): Promise<void> {
  const version = (transcripts.get(conversationId)?.version ?? 0) + 1;
  transcripts.set(conversationId, { jsonl, version });
  const set = watchers.get(conversationId);
  if (set === undefined) return;
  const snapshot = {
    events: await parse(jsonl),
    signature: signatureOf(conversationId),
  };
  for (const onChange of set) onChange(snapshot);
}
