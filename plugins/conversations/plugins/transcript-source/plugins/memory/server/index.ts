import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TranscriptSource } from "@plugins/conversations/plugins/transcript-source/server";
import { memoryTranscripts } from "./internal/memory-transcripts";

export { writeTranscript } from "./internal/memory-transcripts";

export default {
  description:
    "Transcripts in memory: provides the TranscriptSource host service for a host without Claude Code's session files (the browser composition), from JSONL text written to it. Never booted by the desktop.",
  portable: true,
  contributions: [TranscriptSource.provide(memoryTranscripts)],
} satisfies ServerPluginDefinition;
