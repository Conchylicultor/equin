import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { formatChangedSources } from "@plugins/framework/plugins/tooling/plugins/format/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

/**
 * Contains ZERO new logic on purpose: a thin wrapper over the exact
 * `formatChangedSources` that `./equin build` calls, or the repo's format
 * policy would have two implementations that could disagree.
 */
const run: CliAction<[], object> = async () => {
  const root = await getWorktreeRoot();
  const { formatted } = await formatChangedSources({
    root,
    log: (line) => console.log(line),
  });
  console.log(`Formatted ${formatted.length} file(s).`);
};

export default run;
