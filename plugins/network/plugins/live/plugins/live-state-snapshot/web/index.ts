import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { liveStateHandoffConfig } from "../core";

export default {
  description:
    "Registers the epoch handoff's switch (Hand live state over across restarts) for Settings → Config.",
  contributions: [ConfigV2.WebRegister({ descriptor: liveStateHandoffConfig })],
} satisfies PluginDefinition;
