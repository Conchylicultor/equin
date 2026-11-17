import { join } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { cargoBinary } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { installerWindow } from "../../deps";

const run: CliAction<[], { pace?: string; fail?: string }> = async (opts) => {
  const ready = await ensureDep(installerWindow, cliExecContext(), {
    log: (line) => console.error(line),
  });
  // stdin inherited: the window hands the terminal to the install (sudo).
  const result = await spawnPassthrough(
    [
      cargoBinary(ready),
      "--script",
      join(REPO_ROOT, "install.sh"),
      "--",
      "--dry-run",
    ],
    {
      stdin: "inherit",
      env: {
        ...process.env,
        ...envEntries({
          INSTALL_DRY_RUN_PACE: opts.pace ?? "0.4",
          INSTALL_DRY_RUN_FAIL: opts.fail,
        }),
      },
    },
  );
  process.exitCode = result.exitCode ?? 1;
};

export default run;
