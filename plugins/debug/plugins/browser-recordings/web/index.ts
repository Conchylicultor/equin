import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ConversationArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { RecordingFooter } from "./components/recording-footer";
import {
  BROWSER_RECORDING_ICON,
  RecordingsSection,
} from "./components/recordings-section";
import {
  BROWSER_RECORDING_KIND,
  extractBrowserRecordings,
} from "./internal/extract";

export default {
  description:
    "Shows the recording of the browser a tool call drove — an e2e run's filmstrip (the page after each step) or a browser_* call's frame, opening the full-window viewer — under its card in the conversation, and gathered as the conversation's Browser recordings artifact.",
  contributions: [
    JsonlViewerTool.Footer({
      id: "browser-recording",
      component: RecordingFooter,
    }),
    ConversationArtifacts.Kind({
      id: BROWSER_RECORDING_KIND,
      label: "Browser recordings",
      icon: BROWSER_RECORDING_ICON,
      // Verification the agent ran on the way, like its screenshots — listed,
      // never counted on the button as something the conversation made.
      origin: "consumed",
      extract: extractBrowserRecordings,
      Section: RecordingsSection,
    }),
  ],
} satisfies PluginDefinition;
