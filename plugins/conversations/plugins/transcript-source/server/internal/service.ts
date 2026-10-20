import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { JsonlEvent } from "../../core";
import type { TranscriptImageRead } from "./image-key";

/** A transcript's events together with the signature they were read under. */
export interface TranscriptSnapshot {
  events: JsonlEvent[];
  signature: string;
}

/**
 * Where a conversation's transcript comes from. On the desktop it is Claude
 * Code's session files on disk (`transcript-watcher#machine` reads, signs and
 * watches them); a host without them provides its own (the browser host's
 * in-memory transcripts). Both hand the raw JSONL to the same parser
 * (`buildJsonlEvents`), so what a reader sees does not depend on the host.
 */
export interface TranscriptSourceImpl {
  /**
   * Moves whenever `events` would answer differently — a cheap probe, the
   * ETag of every value read from `events`.
   */
  signature(conversationId: string): Promise<string>;
  /** The transcript's events: the whole session chain, parsed. */
  events(conversationId: string): Promise<JsonlEvent[]>;
  /**
   * Calls `onChange` with the new snapshot after every change to the
   * transcript; returns the unsubscribe. Starts synchronously.
   */
  watch(
    conversationId: string,
    onChange: (snapshot: TranscriptSnapshot) => void,
  ): () => void;
  /**
   * The bytes of an image the transcript shows, by its key
   * (`TranscriptImage.key`) — any transcript's, a sub-agent's included; the key
   * says where they are (`readImageKey` answers it over the host's storage).
   * Throws `TranscriptImageKeyError` on a string that is not a key.
   */
  image(key: string): Promise<TranscriptImageRead>;
}

export const TranscriptSource = defineHostService<TranscriptSourceImpl>(
  "conversations.transcript-source",
);
