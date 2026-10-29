import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { transcriptChainSignature } from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  SubagentRefSchema,
  type SubagentActivityRow,
  type SubagentRef,
  type SubagentTranscript,
} from "../../core";
import {
  activityTargetsIn,
  evictActivityScan,
  scanActivityIn,
} from "./activity-scan";
import { subagentDirsOf } from "./discovery";
import { transcriptPaths, readSubagentTranscriptOf } from "./transcript-read";
import { evictAgentCallNames } from "./agent-calls";

// Both memos bind their signature and their compute at construction, exactly as
// `jsonl-events-cache.ts` does. A resource's `revalidate` and its `loader` are
// then provably the same function of the same inputs — not two probes agreeing
// by convention, which is how `edited-files` once certified a stale value with a
// fresh ETag. There is nothing to pass, so there is nothing to drift.
//
// The signature is `transcriptChainSignature` over the files the value is read
// from — a list length plus a per-file `(lstat mtime, size)` triple. It is a
// faithful function of every input the compute reads: an append moves a triple,
// a NEW sub-agent moves the length, a `.meta.json` landing after its transcript
// adds a triple. Routing through that one bound signature (never `lstat` by
// hand, never `Bun.file().lastModified`, which is integer-ms where `lstat` is a
// sub-ms float) is what makes the watcher's primed signature and the resource's
// probe byte-identical strings, so a prime is a real hit rather than a silent
// miss that degrades every push into a full re-read.
//
// Both take the parent conversation's anchored transcript paths as their INPUT,
// resolved from the chain the value follows (`resolveTranscriptPathsOf`) — by
// the loader, and by the watcher room from the rows its start was handed — so
// no memo half reads Postgres, an entry read under another chain is never a
// hit, and the room primes under the very signature the loader probes.

const activityMemo = createSignedMemo<SubagentActivityRow[], readonly string[]>(
  {
    name: "subagent-activity",
    signature: async (_conversationId, parentPaths) =>
      transcriptChainSignature(
        (await activityTargetsIn(subagentDirsOf(parentPaths))).paths,
      ),
    compute: (conversationId, parentPaths) =>
      scanActivityIn(conversationId, subagentDirsOf(parentPaths)),
  },
);

export const subagentActivityMemo = activityMemo;

export function primeSubagentActivity(
  conversationId: string,
  signature: string,
  rows: SubagentActivityRow[],
): void {
  activityMemo.prime(conversationId, signature, rows);
}

export function evictSubagentActivity(conversationId: string): void {
  activityMemo.evict(conversationId);
  evictActivityScan(conversationId);
}

// A signed memo is keyed by ONE string, and this resource is keyed by a
// conversation plus a sub-agent ref. NUL cannot occur in a conversation uuid, a
// Claude tool-use id or an agent id, so it is the one separator that cannot
// collide with any part.
const SEP = "\u0000";

export function transcriptMemoKey(
  conversationId: string,
  ref: SubagentRef,
): string {
  return [conversationId, ref.by, ref.key].join(SEP);
}

function parseMemoKey(key: string): {
  conversationId: string;
  ref: SubagentRef;
} {
  const [conversationId, by, refKey, ...rest] = key.split(SEP);
  const ref = SubagentRefSchema.safeParse({ by, key: refKey });
  if (conversationId === undefined || !ref.success || rest.length > 0) {
    throw new Error(`[subagents] malformed transcript memo key: ${key}`);
  }
  return { conversationId, ref: ref.data };
}

const transcriptMemo = createSignedMemo<SubagentTranscript, readonly string[]>({
  name: "subagent-transcript",
  signature: async (key, parentPaths) => {
    const { conversationId, ref } = parseMemoKey(key);
    return transcriptChainSignature(
      await transcriptPaths(conversationId, ref, parentPaths),
    );
  },
  compute: (key, parentPaths) => {
    const { conversationId, ref } = parseMemoKey(key);
    return readSubagentTranscriptOf(conversationId, ref, parentPaths);
  },
});

export const subagentTranscriptMemo = transcriptMemo;

export function primeSubagentTranscript(
  key: string,
  signature: string,
  value: SubagentTranscript,
): void {
  transcriptMemo.prime(key, signature, value);
}

export function evictSubagentTranscript(key: string): void {
  transcriptMemo.evict(key);
}

/**
 * Drop the parent-chain `Agent`-call name index. Keyed by conversation, not by
 * the transcript memo's (conversation, tool-use id) pair, so it is evicted with
 * the activity subscription rather than with any one pane.
 */
export function evictConversationJoin(conversationId: string): void {
  evictAgentCallNames(conversationId);
}
