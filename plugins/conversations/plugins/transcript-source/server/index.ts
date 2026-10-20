import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { TranscriptSource } from "./internal/service";
export type {
  TranscriptSourceImpl,
  TranscriptSnapshot,
} from "./internal/service";
// The Claude Code JSONL parser: a provider holds a chain's lines
// (`TranscriptLines`, appended a chunk at a time) and builds the events from
// them.
export { buildJsonlEvents } from "./internal/parse-jsonl";
export type { TranscriptImageReader } from "./internal/parse-jsonl";
export { TranscriptLines } from "./internal/transcript-lines";
// Images by reference: the key a host mints for a prompt's image file, and the
// read every host answers `TranscriptSource.image` with over its own storage.
export {
  encodeImageKey,
  readImageKey,
  TranscriptImageKeyError,
} from "./internal/image-key";
export type {
  TranscriptImageIo,
  TranscriptImageRead,
} from "./internal/image-key";
// What resolving a conversation's transcript chain reads from Postgres, as a
// live value's declared `reads` — every value whose loader reads a transcript
// passes it.
export { transcriptChainReads } from "./internal/chain-reads";

export default {
  portable: true,
  description:
    "A conversation's transcript as a host service: TranscriptSource (its events, a signature that moves with them, and a watch), with the Claude Code JSONL parser every provider runs. The desktop's provider reads the session files (transcript-watcher#machine); a host without them provides its own (plugins/memory).",
} satisfies ServerPluginDefinition;
