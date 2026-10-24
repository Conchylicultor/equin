import {
  transcriptMeta,
  transcriptRows,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server";
import type { TranscriptEventRow } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import {
  lastHandback,
  type SubagentTranscript,
  type SubagentTranscriptMeta,
} from "../../core";

/**
 * A sub-agent's transcript as `subagentTranscript` pages it: `jsonlEvents`'
 * rows (a tool call keyed by its tool-use id, anything else by its position),
 * or none while no file is linked — the meta says why.
 */
export function subagentTranscriptRows(
  transcript: SubagentTranscript,
): readonly TranscriptEventRow[] {
  return transcript.kind === "linked" ? transcriptRows(transcript.events) : [];
}

/** What only the whole transcript knows (`subagentTranscript.meta`), link state first. */
export function subagentTranscriptMeta(
  transcript: SubagentTranscript,
): SubagentTranscriptMeta {
  if (transcript.kind !== "linked") return transcript;
  const { count, firstAssistantSeq } = transcriptMeta(transcript.events);
  return {
    kind: "linked",
    agentId: transcript.agentId,
    count,
    firstAssistantSeq,
    handback: lastHandback(transcript.events),
    prompts: transcriptRows(transcript.events).filter(
      (row) => row.event.kind === "user-text",
    ),
  };
}
