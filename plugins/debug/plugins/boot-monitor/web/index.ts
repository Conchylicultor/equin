import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { bootMonitorConfig } from "../core";

export default {
  collapsed: true,
  description:
    "Boot-monitor web presence: registers the time-to-ready budget config (enabled, readyBudgetMs) for Settings → Config. The minted signals flow through the existing slow-op report kind and the boot trace lane — no new renderer.",
  contributions: [ConfigV2.WebRegister({ descriptor: bootMonitorConfig })],
} satisfies PluginDefinition;
