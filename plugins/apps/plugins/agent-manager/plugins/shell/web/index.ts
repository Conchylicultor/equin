import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { agentManagerApp } from "../core";
import { AgentManagerLayout } from "./components/agent-manager-layout";
import { EquinMark } from "./components/equin-mark";
import { mistTheme } from "./internal/theme";

export default {
  description:
    "App shell for the agent manager. Registers the /agents app entry, renders the main Shell layout, and contributes the app's own theme (Mist), which the agent manager selects.",
  contributions: [
    Apps.App({
      app: agentManagerApp,
      mark: EquinMark,
      component: AgentManagerLayout,
    }),
    // The agent manager's theme, selected for the app in
    // `config/ui/theme-engine/@app/agent-manager/theme.jsonc`.
    ThemeEngine.Theme(mistTheme),
  ],
} satisfies PluginDefinition;
