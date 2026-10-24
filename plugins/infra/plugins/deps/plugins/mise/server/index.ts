import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { UpdaterDeclare } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { miseUpdater } from "../core";

export default {
  description:
    "The mise toolchain as an updater: contributes `mise` to the updater registry, so the Dependency upgrades automation includes it in the batched upgrade task and `./equin deps upgrade mise` (alias: `toolchain upgrade`) moves mise.lock through the gated runner.",
  contributions: [UpdaterDeclare({ updater: miseUpdater })],
} satisfies ServerPluginDefinition;
