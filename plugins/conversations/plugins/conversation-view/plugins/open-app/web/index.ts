import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { Hints } from "@plugins/hints/web";
import { OpenAppButton } from "./components/open-app-button";
import { tryItHint } from "../core";
import { openAppConfig } from "../shared/config";
import {
  appPreviewPane,
  OpenInNewTabAction,
  ReloadAction,
  ToggleChromeAction,
} from "./app-preview-pane";

export default {
  description:
    "Opens the conversation's namespace (`http://<id>.localhost:9000`) on the page its task was filed from when one was attached (else `/`) — in a new browser tab by default, or framed in a pane beside the chat when the Open app in setting says so (⌘/middle-click takes the other way). The pane's header actions reload the frame, show or hide the framed app's own chrome, and open it in a browser tab. Disabled until the worktree has a successful build (op-store build history).",
  contributions: [
    ConfigV2.WebRegister({ descriptor: openAppConfig }),
    Conversation.ActionBar({
      id: "open-app",
      requires: ["build"],
      component: OpenAppButton,
    }),
    Hints.Hint({ hint: tryItHint }),
    Pane.Register({ pane: appPreviewPane }),
    appPreviewPane.Actions({ id: "reload", component: ReloadAction }),
    appPreviewPane.Actions({
      id: "toggle-chrome",
      component: ToggleChromeAction,
    }),
    appPreviewPane.Actions({
      id: "open-in-new-tab",
      component: OpenInNewTabAction,
    }),
  ],
  slots: {
    "app-preview": appPreviewPane,
  },
} satisfies PluginDefinition;
