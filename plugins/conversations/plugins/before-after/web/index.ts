import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ConversationArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { baIdKind, BEFORE_AFTER_ARTIFACT_KIND } from "../core";
import { beforeAfterPane, beforeAfterPaneActions } from "./panes";
import {
  RegisterBeforeAfterToolView,
  RegisterBeforeAfterViewSchema,
} from "./components/tool-view";
import { BeforeAfterSection } from "./components/artifacts-section";
import { BEFORE_AFTER_ICON } from "./internal/icon";

export { beforeAfterPane } from "./panes";
export { BEFORE_AFTER_ICON } from "./internal/icon";

export default {
  description:
    "Before / after pairs in the browser: registers the ba id kind; draws a register_before_after call as its tool row with a swipe preview of the pair under it (read back by tool-use id; Open in pane); the Before / after pane keyed by pair id — the pair large (Swipe / Side by side / Flip, full screen with ← / → through the conversation's pairs) over a filmstrip gallery of every pair of its conversation; and the Before / after section of the conversation's Artifacts (split thumbnails opening the pane).",
  slots: { pane: beforeAfterPane },
  contributions: [
    IdKinds.Kind({ kind: baIdKind }),
    Pane.Register({ pane: beforeAfterPane }),
    ...beforeAfterPaneActions,
    JsonlViewerTool.Renderer({
      match: /register_before_after$/,
      icon: BEFORE_AFTER_ICON,
      input: RegisterBeforeAfterViewSchema,
      component: RegisterBeforeAfterToolView,
    }),
    ConversationArtifacts.Kind({
      id: BEFORE_AFTER_ARTIFACT_KIND,
      label: "Before / after",
      icon: BEFORE_AFTER_ICON,
      Section: BeforeAfterSection,
    }),
  ],
} satisfies PluginDefinition;
