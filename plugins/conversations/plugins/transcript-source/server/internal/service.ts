import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { JsonlEvent, TranscriptChain } from "../../core";
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
   * Moves whenever `events` would answer differently for the same `chain` — a
   * cheap probe, the ETag of every value read from `events`.
   *
   * Both reads take the chain's FACTS (`TranscriptChain`: the recorded
   * session ids) from the caller, which read them — a live value through its
   * `follows` (`transcriptChainFollows`), so the read is routed per
   * conversation. A provider never reads them itself: the desktop's resolves
   * the ids to its files from the filesystem alone; one without per-session
   * storage (the memory provider) ignores them.
   */
  signature(conversationId: string, chain: TranscriptChain): Promise<string>;
  /** The transcript's events: the whole session chain, parsed. */
  events(conversationId: string, chain: TranscriptChain): Promise<JsonlEvent[]>;
  /**
   * Calls `onChange` with the new snapshot after every change to the
   * transcript; returns the unsubscribe. Starts synchronously. The watch
   * follows the chain by itself (outside any loader), so its snapshot's
   * signature equals `signature(id, chain)` for the chain it read.
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
