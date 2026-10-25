import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { GitDefaultsPreviewSwitch } from "./components/git-defaults-preview-switch";
import { PreviewIndicator } from "./components/preview-indicator";

export default {
  description:
    "The git-defaults preview, for developers: a switch in the action bar's view-options popover makes this tab read every config from the committed layer (what a brand-new user sees) instead of the user's own, read-only, and an action-bar mark shows while it is on (click to exit; it toasts a refused write).",
  contributions: [
    ActionBar.ViewOption({
      id: "git-defaults-preview",
      component: GitDefaultsPreviewSwitch,
    }),
    ActionBar.Item({ id: "git-defaults-preview", component: PreviewIndicator }),
  ],
} satisfies PluginDefinition;
