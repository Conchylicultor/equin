import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { IdKinds } from "@plugins/ids/web";
import { supervisorPromptConfig, supervisorRoleIdKind } from "../core";
import { supervisorPresentation } from "./internal/presentation";

export default {
  description:
    "Supervisor roles, web half: registers the srole id kind, the shared supervisor prompt config (Settings → Config) and the exposed `supervisor` field of every task list, its options the live roles by name.",
  contributions: [
    IdKinds.Kind({ kind: supervisorRoleIdKind }),
    ConfigV2.WebRegister({ descriptor: supervisorPromptConfig }),
    supervisorPresentation,
  ],
} satisfies PluginDefinition;
