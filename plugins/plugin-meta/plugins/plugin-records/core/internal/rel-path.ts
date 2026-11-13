import { pluginDirOfRepoPath } from "@plugins/framework/plugins/plugin-id/core";

/**
 * The plugin a repo path belongs to (`plugins/a/plugins/b`), or its top
 * directory outside `plugins/`: the unit records are read in (`readGrouped`).
 */
export function relOwner(rel: string): string {
  return pluginDirOfRepoPath(rel) ?? rel.split("/")[0]!;
}
