import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { UserTextRow } from "./components/user-text-row";
import { RawTextToggleAction } from "./components/raw-toggle-action";
import { CopyUserTextAction } from "./components/copy-text-action";

export default {
  description: "Renders user text events in the JSONL viewer.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "user-text", component: UserTextRow }),
    JsonlRowActions.Item({
      id: "copy-user-text",
      component: CopyUserTextAction,
    }),
    JsonlRowActions.Item({
      id: "raw-text-toggle",
      component: RawTextToggleAction,
    }),
  ],
} satisfies PluginDefinition;
