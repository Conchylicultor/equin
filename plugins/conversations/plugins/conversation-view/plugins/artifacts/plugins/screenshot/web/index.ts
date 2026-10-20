import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConversationArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { SCREENSHOT_KIND } from "../core";
import {
  SCREENSHOT_ICON,
  ScreenshotSection,
} from "./components/screenshot-section";

export default {
  description:
    "Screenshots as a conversation artifact: every picture the agent read, shown as a four-up thumbnail grid that is one ← / → set in the full-window image viewer.",
  contributions: [
    ConversationArtifacts.Kind({
      id: SCREENSHOT_KIND,
      label: "Screenshots",
      icon: SCREENSHOT_ICON,
      Section: ScreenshotSection,
    }),
  ],
} satisfies PluginDefinition;
