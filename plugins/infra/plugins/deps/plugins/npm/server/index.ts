import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { UpdaterDeclare } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { npmUpdater } from "./internal/npm-updater";

export default {
  description:
    "The `npm` updater: moves every npm package a workspace package.json declares (its range and bun.lock) to the newest release past a 3-day cooldown, lockstep groups together, honouring expiring holds — contributed to the infra/deps updater registry.",
  contributions: [UpdaterDeclare({ updater: npmUpdater })],
} satisfies ServerPluginDefinition;
