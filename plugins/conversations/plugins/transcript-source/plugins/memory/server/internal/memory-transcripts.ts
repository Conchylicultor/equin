import { hostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  readImageKey,
  TranscriptLines,
  wholeBytes,
  type TranscriptImageIo,
  type TranscriptSnapshot,
  type TranscriptSourceImpl,
} from "@plugins/conversations/plugins/transcript-source/server";

// Each conversation's transcript as Claude Code JSONL bytes, with a version that
// moves on every write — the signature. Held in memory and written through to
// the host's storage (`transcripts`), so a persistent host reads them back
// after a reload; loaded on first use, never at module evaluation.
// The version is stored with the bytes, so a signature read after a reload
// never repeats one an earlier transcript had.
interface StoredTranscript {
  jsonl: Uint8Array;
  version: number;
}
const persisted = () =>
  hostStorage().store<StoredTranscript>("transcripts", {
    shiftTime: (stored, ms) => ({
      ...stored,
      jsonl: shiftLineTimestamps(stored.jsonl, ms),
    }),
  });

/**
 * A transcript loaded from a snapshot taken earlier, every line's `timestamp`
 * (Claude Code's per-event instant) moved by `ms`. Loud on a line that is not
 * JSON: a transcript this store wrote is JSONL.
 */
function shiftLineTimestamps(jsonl: Uint8Array, ms: number): Uint8Array {
  const lines = new TextDecoder().decode(jsonl).split("\n");
  const shifted = lines.map((line) => {
    if (line.trim() === "") return line;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.timestamp !== "string") return line;
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at))
      throw new Error(
        `[memory-transcripts] a line's timestamp is not an instant: ${event.timestamp}`,
      );
    return JSON.stringify({
      ...event,
      timestamp: new Date(at + ms).toISOString(),
    });
  });
  return new TextEncoder().encode(shifted.join("\n"));
}
let held: Map<string, StoredTranscript> | null = null;
const transcriptsMap = (): Map<string, StoredTranscript> =>
  (held ??= new Map(persisted().loaded));
const watchers = new Map<string, Set<(snapshot: TranscriptSnapshot) => void>>();

// No files beside the transcript, so a prompt's referenced image is never here:
// it renders as the path it names.
const noImages = async (): Promise<null> => null;

/** The transcript "file" an image key names: the conversation's stored JSONL. */
const fileOf = (id: string): string => `memory:${id}`;

async function parse(id: string): Promise<JsonlEvent[]> {
  const lines = new TranscriptLines(noImages);
  const jsonl = transcriptsMap().get(id)?.jsonl;
  if (jsonl) await lines.catchUp(fileOf(id), jsonl.length, wholeBytes(jsonl));
  return lines.events();
}

const signatureOf = (id: string): string =>
  `memory:${transcriptsMap().get(id)?.version ?? 0}`;

const memoryImageIo: TranscriptImageIo = {
  readRange: async (file, offset, length) => {
    const jsonl = file.startsWith("memory:")
      ? transcriptsMap().get(file.slice("memory:".length))?.jsonl
      : undefined;
    return jsonl ? jsonl.subarray(offset, offset + length) : null;
  },
  readPath: async () => null,
};

// One transcript per conversation, no session files: the chain names nothing
// to read here, so both halves ignore it.
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
  const version = (transcriptsMap().get(conversationId)?.version ?? 0) + 1;
  const text = jsonl.endsWith("\n") || jsonl === "" ? jsonl : `${jsonl}\n`;
  const stored = { jsonl: new TextEncoder().encode(text), version };
  transcriptsMap().set(conversationId, stored);
  persisted().put(conversationId, stored);
  const set = watchers.get(conversationId);
  if (set === undefined) return;
  const snapshot = {
    events: await parse(conversationId),
    signature: signatureOf(conversationId),
  };
  for (const onChange of set) onChange(snapshot);
}
