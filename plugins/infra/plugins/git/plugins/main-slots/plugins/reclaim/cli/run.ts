import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { reclaimSlots } from "@plugins/infra/plugins/git/plugins/main-slots/cli";

const run: CliAction<[], Record<string, never>> = async () => {
  const { filed, removed } = await reclaimSlots();
  console.log(
    `[main-slots] reclaim: ${filed.length} slow drain${filed.length === 1 ? "" : "s"} reported, ${removed.length} free slot${removed.length === 1 ? "" : "s"} removed${removed.length > 0 ? ` (${removed.join(", ")})` : ""}`,
  );
};

export default run;
