import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  duressIdleBlocker,
  duressLatchWatcher,
  startDuressWatch,
  stopDuressWatch,
} from "./internal/duress-blocker";

export default {
  description:
    "Idle blocker `duress`: a fresh host duress latch keeps the host busy, and asks to be re-read when its lease could lapse (a lapse emits no event). On main, a watch on the latch dir asks for a re-evaluation when duress starts or ends.",
  register: [duressLatchWatcher],
  contributions: [duressIdleBlocker],
  onReady: startDuressWatch,
  onShutdown: stopDuressWatch,
} satisfies MachinePluginDefinition;
