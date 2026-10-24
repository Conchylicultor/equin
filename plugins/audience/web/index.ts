import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { audienceConfig } from "../shared/config";

export { useAudience } from "./use-audience";
export { useSetDeveloperMode } from "./use-set-developer-mode";

export default {
  description:
    "Who the user is (user | developer), read live as useAudience() from the Developer mode config; registers that config.",
  contributions: [ConfigV2.WebRegister({ descriptor: audienceConfig })],
} satisfies PluginDefinition;
