import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { gatewayPortSync } from "../data-dirs";

const run: CliAction<[], object> = () => {
  process.stdout.write(
    `${namespaceUrl(MAIN_WORKTREE_NAME, "", gatewayPortSync())}\n`,
  );
  return Promise.resolve();
};

export default run;
