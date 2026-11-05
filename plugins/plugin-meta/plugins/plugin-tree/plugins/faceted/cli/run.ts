import { writeFile } from "node:fs/promises";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import { pluginTreeToJson } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFacetedPluginTree } from "../core";

/**
 * The tree is read off a snapshot of the checkout with the shared plugin
 * records installed, as a build reads it: only the plugins whose files changed
 * since any checkout last extracted them are extracted again, so the usual
 * call (a plugin edited, main after a push) costs a few plugins, not the
 * seconds of every facet over every plugin.
 */
const run: CliAction<[string], object> = async (out) => {
  const root = await getWorktreeRoot();
  installRecordStore(openRecordStore());
  const tree = await buildFacetedPluginTree(joinAppPath(root, "plugins"), {
    repo: await loadRepoSnapshot(root),
  });
  await writeFile(out, JSON.stringify(pluginTreeToJson(tree)));
};

export default run;
