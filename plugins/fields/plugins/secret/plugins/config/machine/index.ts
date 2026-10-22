import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import "./internal/register";
import { configSecretMetaServed } from "./internal/resource";

export default {
  description:
    "Secret field type: encrypted storage with set/not-set metadata. Desktop-only: the secrets store is the computer's (central), so the storage provider and the config-v2.secret-meta value (needsMachine) live here.",
  contributions: [...configSecretMetaServed.declare],
} satisfies MachinePluginDefinition;
