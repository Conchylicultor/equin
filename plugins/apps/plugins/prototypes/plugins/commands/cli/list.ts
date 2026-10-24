import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { checkoutNamespace } from "@plugins/infra/plugins/paths/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { printPrototypeList } from "@plugins/apps/plugins/prototypes/plugins/files/cli";
import { readDeletedPrototypes } from "@plugins/apps/plugins/prototypes/plugins/state/cli";

/**
 * `./equin prototype list` — the folders on disk (`files`) minus the ones
 * deleted in this checkout's instance (`state`, its own DB: what this
 * checkout's gallery has in its Trash). The one verb that needs both halves,
 * and the reason the group is declared here rather than in `files`.
 */
const run: CliAction<[], object> = async () => {
  const ns = await checkoutNamespace(await getWorktreeRoot());
  await printPrototypeList(await readDeletedPrototypes(ns));
};

export default run;
