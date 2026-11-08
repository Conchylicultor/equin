import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { corpusCheckpointJob } from "./internal/checkpoint-job";

export { defineCorpusIndex } from "./internal/corpus-index";
export type {
  CheckpointOutcome,
  CorpusIndexSpec,
  CorpusIndex,
  CorpusDelta,
  CorpusWatch,
} from "./internal/corpus-index";

export default {
  description:
    "Fingerprint-keyed incremental file index: defineCorpusIndex enumerates files under roots matching a predicate, re-parses only those whose (mtimeMs,size) changed through a bounded heavy-read-gated pipeline, drops vanished entries, and persists atomically (host scope ⇒ main-only). ensureFresh is the lazy on-read correctness fallback; startWatcher is main-only push freshness. The corpus-index.checkpoint job (every 5 min, main) saves each watched root's journal cursor up to where its live watch vouches, so a boot's catch-up replays only what no watch heard.",
  register: [corpusCheckpointJob],
} satisfies ServerPluginDefinition;
