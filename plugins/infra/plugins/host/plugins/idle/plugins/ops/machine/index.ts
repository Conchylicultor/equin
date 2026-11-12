import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  liveOpsWatcher,
  opsIdleBlocker,
  startOpsWatch,
  stopOpsWatch,
} from "./internal/ops-blocker";

export default {
  description:
    "Idle blocker `ops`: any op running on the host (build, push, check, test, e2e) keeps it busy — read from the host-wide live-ops markers (flock-probed), an opportunistic op (the idle test batch) excepted. On main, a watch on the live-ops dir asks for a re-evaluation on every op start and end.",
  register: [liveOpsWatcher],
  contributions: [opsIdleBlocker],
  onReady: startOpsWatch,
  onShutdown: stopOpsWatch,
} satisfies MachinePluginDefinition;
