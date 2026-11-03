import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { modelCatalog, type ModelCatalog } from "../../core";

/**
 * The model catalog — which version each family runs today, which versions
 * exist, which are retired — pushed live from the host-global catalog that
 * discovery maintains. Preloaded (`boot-and-keep`), so it is settled on the
 * first render of every surface; a new model shows up in every picker and
 * hint the moment it is discovered, with no reload.
 */
export function useModelCatalog(): ResourceResult<ModelCatalog> {
  return useLive(modelCatalog);
}
