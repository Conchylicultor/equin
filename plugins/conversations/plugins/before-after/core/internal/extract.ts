import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { agentToolName } from "@plugins/infra/plugins/mcp/core";
import { REGISTER_BEFORE_AFTER_TOOL } from "./tool-input";

/** This artifact kind's id — the one spelling, shared by the extractor, its hits and the web kind. */
export const BEFORE_AFTER_ARTIFACT_KIND = "before-after";

const TOOL_NAME = agentToolName(REGISTER_BEFORE_AFTER_TOOL);

/**
 * PURE. One `register_before_after` call is one pair, keyed by its tool-use
 * id — the key its row is filed under (`toolUseId`). `created`: the call made
 * it. A call that FAILED registered nothing and is left out; one still running
 * (no result yet), or cut off by a restart (`outcomeUnknown`: it may have
 * landed), is in — the section reads the row, and shows it once it lands.
 */
export function extractBeforeAfterHits(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call" || event.name !== TOOL_NAME) return [];
  const result = event.result;
  if (result?.isError === true && result.outcomeUnknown !== true) return [];
  return [
    {
      kind: BEFORE_AFTER_ARTIFACT_KIND,
      key: event.toolUseId,
      relation: "created",
      at: event.at,
    },
  ];
}
