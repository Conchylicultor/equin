import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TranscriptSource } from "@plugins/conversations/plugins/transcript-source/server";
import { diskTranscripts } from "./internal/disk-transcripts";

export default {
  description:
    "Transcripts on disk, desktop-only half: provides the TranscriptSource host service from Claude Code's session files — the chain resolved from the session table, signed by each file's mtime and size, watched by the one transcript watcher.",
  contributions: [TranscriptSource.provide(diskTranscripts)],
} satisfies MachinePluginDefinition;
