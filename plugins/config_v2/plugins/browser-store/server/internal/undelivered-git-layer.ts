import type { ConfigGitLayerImpl } from "@plugins/config_v2/core";

/**
 * The committed layer of a host the build has not delivered it to yet (the
 * browser worker host). The worker's registry holds no descriptor today, so
 * nothing asks; the first portable registering plugin to reach the worker and
 * remove a scope trips this — loudly, naming the step that delivers the layer —
 * rather than reading an absent layer as "not committed".
 */
export const undeliveredGitLayer: ConfigGitLayerImpl = {
  hasScope(storePath, appId) {
    throw new Error(
      `config-v2: committed layer not delivered to this host (storePath "${storePath}", app "${appId}") — ` +
        "next session: deliver @composition-config-layer to the browser host build and back ConfigGitLayer with it.",
    );
  },
};
