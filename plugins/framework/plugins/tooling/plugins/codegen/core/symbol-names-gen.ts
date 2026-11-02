import { renderSymbolNameFiles } from "@plugins/ui/plugins/icons/plugins/icon-sets/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { writeGenerated } from "./write-generated";

/**
 * Writes the icon name unions (`icons/core/symbol-names.generated.ts`) and the
 * saved-names runtime list, derived from the installed `@iconify-json/*` sets
 * (`ui/icons/icon-sets`). A function of `node_modules`, not of the plugin
 * tree — which is why it belongs in the repo-tree pipeline: the npm updater
 * runs `regen-generated` after every move, so an icon-set upgrade carries its
 * own regenerated names instead of failing `icons:symbol-names-in-sync`.
 */
export async function generateSymbolNames({
  root,
}: {
  root: AppPath;
}): Promise<void> {
  for (const { path, content } of renderSymbolNameFiles()) {
    await writeGenerated({ file: joinAppPath(root, path), content });
  }
}
