import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ModelCatalogSource } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  startCliVersionTrigger,
  stopCliVersionTrigger,
} from "./internal/cli-version-trigger";
import { modelsDiscoverJob } from "./internal/discover-job";
import { modelUnrecognizedKind } from "./internal/report-kinds";
import {
  modelCatalogWatcher,
  readFileCatalog,
  startCatalogWatcher,
  stopCatalogWatcher,
} from "./internal/store";

export default {
  description:
    "The desktop's model catalog: provides ModelCatalogSource from the host-global catalog.json (in memory, re-read by a file watcher, the baseline until the first discovery), and the models.discover job — daily and on every new Claude CLI version, it reads the CLI's model menu (the Agent SDK `initialize` control request, answered locally: no model call), makes each family run what its alias resolves to (with a bell line when that moves), appends new versions, retires versions the menu no longer offers, and files model-unrecognized for an entry it cannot place.",
  register: [modelsDiscoverJob, modelCatalogWatcher],
  contributions: [
    ModelCatalogSource.provide({ read: readFileCatalog }),
    modelUnrecognizedKind,
  ],
  onReady: async () => {
    await startCatalogWatcher();
    startCliVersionTrigger();
  },
  onShutdown: async () => {
    stopCliVersionTrigger();
    await stopCatalogWatcher();
  },
} satisfies MachinePluginDefinition;
