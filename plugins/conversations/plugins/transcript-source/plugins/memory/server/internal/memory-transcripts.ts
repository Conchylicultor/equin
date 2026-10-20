import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  readImageKey,
  TranscriptLines,
  type TranscriptImageIo,
  type TranscriptSnapshot,
  type TranscriptSourceImpl,
} from "@plugins/conversations/plugins/transcript-source/server";

// Each conversation's transcript as Claude Code JSONL bytes, with a version that
// moves on every write — the signature. Lost with the process.
const transcripts = new Map<string, { jsonl: Uint8Array; version: number }>();
const watchers = new Map<string, Set<(snapshot: TranscriptSnapshot) => void>>();

// No files beside the transcript, so a prompt's referenced image is never here:
// it renders as the path it names.
const noImages = async (): Promise<null> => null;

/** The transcript "file" an image key names: the conversation's stored JSONL. */
const fileOf = (id: string): string => `memory:${id}`;

function parse(id: string): Promise<JsonlEvent[]> {
  const lines = new TranscriptLines(noImages);
  const jsonl = transcripts.get(id)?.jsonl;
  if (jsonl) lines.append(fileOf(id), 0, jsonl);
  return lines.events();
}

const signatureOf = (id: string): string =>
  `memory:${transcripts.get(id)?.version ?? 0}`;

const memoryImageIo: TranscriptImageIo = {
  readRange: async (file, offset, length) => {
    const jsonl = file.startsWith("memory:")
      ? transcripts.get(file.slice("memory:".length))?.jsonl
      : undefined;
    return jsonl ? jsonl.subarray(offset, offset + length) : null;
  },
  readPath: async () => null,
};

export const memoryTranscripts: TranscriptSourceImpl = {
  signature: async (id) => signatureOf(id),
  events: async (id) => parse(id),
  watch: (id, onChange) => {
    const set = watchers.get(id) ?? new Set();
    watchers.set(id, set);
    set.add(onChange);
    return () => {
      set.delete(onChange);
      if (set.size === 0) watchers.delete(id);
    };
  },
  image: (key) => readImageKey(key, memoryImageIo),
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
  const text = jsonl.endsWith("\n") || jsonl === "" ? jsonl : `${jsonl}\n`;
  transcripts.set(conversationId, {
    jsonl: new TextEncoder().encode(text),
    version,
  });
  const set = watchers.get(conversationId);
  if (set === undefined) return;
  const snapshot = {
    events: await parse(conversationId),
    signature: signatureOf(conversationId),
  };
  for (const onChange of set) onChange(snapshot);
}
