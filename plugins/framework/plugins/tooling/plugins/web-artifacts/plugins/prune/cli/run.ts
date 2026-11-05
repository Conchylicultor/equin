import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { pruneWebArtifactCaches } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";

const s = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/** One prune, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = async () => {
  const r = await pruneWebArtifactCaches();
  console.log(
    `survey ${s(r.surveyMs)} (${r.dists} dists, ${r.distsLinksRead} read off their links, ${r.distTargets} linked entries, ${r.surveyedEntries} unlinked entries stat'd); ` +
      `lock wait ${s(r.lockWaitMs)}; locked ${s(r.lockedMs)} (${r.distsReread} dists re-read, ${r.removed} removed)`,
  );
};

export default run;
