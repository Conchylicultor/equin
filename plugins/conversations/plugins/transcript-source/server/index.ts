import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { TranscriptSource } from "./internal/service";
export type {
  TranscriptSourceImpl,
  TranscriptSnapshot,
} from "./internal/service";
// The Claude Code JSONL parser: a provider holds a chain's lines
// (`TranscriptLines`, caught up a chunk at a time from the host's bytes) and
// builds the events from them.
export { buildJsonlEvents } from "./internal/parse-jsonl";
export type { TranscriptImageReader } from "./internal/parse-jsonl";
export { TranscriptLines, wholeBytes } from "./internal/transcript-lines";
export type { TranscriptByteRead } from "./internal/transcript-lines";
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
// The transcript chain's facts as a live value's `follows` — every value whose
// loader reads a transcript follows them, and hands the rows to
// `followedTranscriptChain` for the chain its source reads.
export {
  followedTranscriptChain,
  transcriptChainFollows,
} from "./internal/chain-follows";

export default {
  portable: true,
  description:
    "A conversation's transcript as a host service: TranscriptSource (its events, a signature that moves with them, and a watch), with the Claude Code JSONL parser every provider runs. The desktop's provider reads the session files (transcript-watcher#machine); a host without them provides its own (plugins/memory).",
} satisfies ServerPluginDefinition;
