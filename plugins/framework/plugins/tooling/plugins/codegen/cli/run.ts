import { resolve } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { codegenPassOver, propagateConfigToUser } from "../core";

const run: CliAction<[string], object> = async (userConfigDir) => {
  const { migrations } = await propagateConfigToUser({
    pass: codegenPassOver(await loadRepoSnapshot(await getWorktreeRoot())),
    userConfigDir: asAppPath(resolve(userConfigDir)),
  });
  for (const m of migrations) {
    console.log(
      `Config migration ${m.key}: rewrote ${m.rewritten.length} saved config file(s)`,
    );
  }
};

export default run;
