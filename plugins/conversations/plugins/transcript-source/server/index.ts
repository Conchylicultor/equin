import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { TranscriptSource } from "./internal/service";
export type {
  TranscriptSourceImpl,
  TranscriptSnapshot,
} from "./internal/service";
// The Claude Code JSONL parser: a provider merges a chain's files
// (`mergeChainLines`) and builds the events from them.
export { buildJsonlEvents, mergeChainLines } from "./internal/parse-jsonl";
export type { TranscriptImageReader } from "./internal/parse-jsonl";
// What resolving a conversation's transcript chain reads from Postgres, as a
// live value's declared `reads` — every value whose loader reads a transcript
// passes it.
export { transcriptChainReads } from "./internal/chain-reads";

export default {
  portable: true,
  description:
    "A conversation's transcript as a host service: TranscriptSource (its events, a signature that moves with them, and a watch), with the Claude Code JSONL parser every provider runs. The desktop's provider reads the session files (transcript-watcher#machine); a host without them provides its own (plugins/memory).",
} satisfies ServerPluginDefinition;
