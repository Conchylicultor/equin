import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { STAMP_REL } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const run: CliAction<[], object> = async () => {
  const root = await getWorktreeRoot();
  const stamp = join(root, STAMP_REL);
  // The bootstrap's `ensureDeps()` either wrote the stamp or threw before this
  // command was parsed, so an absent stamp is a broken bootstrap, not a state.
  if (!existsSync(stamp)) {
    throw new Error(
      `install: the bootstrap's dependency install returned, but ${stamp} does not exist`,
    );
  }
  console.log(`install: ${root} is installed (${STAMP_REL})`);
};

export default run;
