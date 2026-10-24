import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { newAppPane } from "./panes";
import { newAppPromptTheme } from "./internal/theme";

export { newAppPane } from "./panes";

export default {
  description:
    "Home's New app screen (/home/new): one prompt — the standard composer field, its Create button opening the launched conversation — above the Prototype → App steps every new app goes through, with a random hand of starting ideas (and a shuffle) while the field is empty. Creating files a task under the Apps category with a minimal prompt: build a new app, prototype first, then the description.",
  contributions: [
    Pane.Register({ pane: newAppPane }),
    ThemeEngine.SubTheme(newAppPromptTheme),
  ],
  slots: { newApp: newAppPane },
} satisfies PluginDefinition;
