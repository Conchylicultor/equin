import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { isRecordedToolCall } from "./recorded-call";

/** This kind's id — the one spelling, shared by the contribution and its hits. */
export const BROWSER_RECORDING_KIND = "browser-recording";

/**
 * PURE. A tool call that drove a browser — an e2e run, a page-changing
 * browser_* call — keyed by its tool-use id, the key its recordings are filed
 * under. `created`: the call made the recording. Whether one exists (a killed
 * run left none) is the section's read, not a guess made here.
 */
export function extractBrowserRecordings(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call") return [];
  if (!isRecordedToolCall(event.name, event.input)) return [];
  return [
    {
      kind: BROWSER_RECORDING_KIND,
      key: event.toolUseId,
      relation: "created",
      at: event.at,
    },
  ];
}
