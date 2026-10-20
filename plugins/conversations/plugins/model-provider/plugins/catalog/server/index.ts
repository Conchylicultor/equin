import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { modelCatalogServed } from "./internal/source";

export {
  getModelCatalog,
  ModelCatalogSource,
  notifyModelCatalogChanged,
} from "./internal/source";

export default {
  description:
    "The model catalog every launch reads: getModelCatalog() over the ModelCatalogSource host service (the desktop's discovered catalog.json, or the code baseline on a host without the computer), and the model-provider.catalog live value served from it.",
  portable: true,
  contributions: [...modelCatalogServed.declare],
} satisfies ServerPluginDefinition;
