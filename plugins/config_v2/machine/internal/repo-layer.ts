import { existsSync } from "node:fs";
import { join } from "node:path";
import { appScopeId, configFileRelPath } from "../../core";
import type { ConfigGitLayerImpl } from "../../core";
import { repoConfigDir } from "@plugins/infra/plugins/paths/server";

/**
 * The desktop's committed layer: the checkout's `config/`. A scoped override is
 * committed at `config/<hier>/@app/<id>/<name>.jsonc` — its origin anchor is
 * always the BASE origin, so the override file alone says the scope is
 * committed.
 */
export const repoConfigLayer: ConfigGitLayerImpl = {
  hasScope(storePath, appId) {
    return existsSync(
      join(
        repoConfigDir(),
        configFileRelPath({
          storePath,
          scopeId: appScopeId(appId),
          file: "override",
        }),
      ),
    );
  },
};
