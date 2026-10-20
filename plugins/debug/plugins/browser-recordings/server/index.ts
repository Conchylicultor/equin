import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { BROWSER_RECORDING_KIND, extractBrowserRecordings } from "../core";
import { browserRecordingRunsServed } from "./internal/list-runs";

export default {
  description:
    "Serves the browser recordings filed under one tool call (the browser-recordings.runs live value) — an e2e run's steps, or a browser_* MCP call's frame — pushed when a run's manifest lands in the browser-recordings data dir.",
  contributions: [
    ...browserRecordingRunsServed.declare,
    // The conversation's Browser recordings artifact, extracted from its
    // whole transcript by the artifacts host. Verification the agent ran on
    // the way, like its screenshots — listed, never counted on the button as
    // something the conversation made.
    ConversationArtifactExtractor({
      id: BROWSER_RECORDING_KIND,
      origin: "consumed",
      extract: extractBrowserRecordings,
    }),
  ],
} satisfies ServerPluginDefinition;
