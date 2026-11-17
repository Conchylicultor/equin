import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { ScreenshotButton } from "./components/screenshot-button";
import { screenshotPane } from "./panes";

export { screenshotPane } from "./panes";
export { captureApp } from "./capture";

export default {
  description:
    "Capture the current page and edit it (crop, draw) in a new tab. The capture is staged as an attachment at once and recorded as kept work, with the committed edits, the strokes not applied yet and the prompt, so a reload of the editor loses nothing (the edited image is derived, never held). Bottom prompt form launches a conversation with the edited screenshot attached.",
  contributions: [
    Pane.Register({ pane: screenshotPane }),
    ActionBar.Item({ id: "screenshot", component: ScreenshotButton }),
  ],
  slots: { screenshot: screenshotPane },
} satisfies PluginDefinition;
