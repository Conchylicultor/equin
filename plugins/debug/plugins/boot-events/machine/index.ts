import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootCrashRegistration, disarmBootCrash } from "./internal/boot-crash";

export {
  clearBootUnsettled,
  markBootUnsettled,
  readBootUnsettled,
  stampBootUnsettledIndexed,
} from "./internal/unsettled-marks";

export default {
  description:
    "Boot crashes as reports, desktop-only half: until the backend is ready, an uncaught throw or rejection is printed, filed as a crash report (error, stack, and the checkout's merge-base with the stack's repo files for the staleness rule) through the report outbox main drains, and the process exits 1 — until a handler is attached to processCrashSink (the reports engine's, from its onReadyBlocking), which owns them from then on. Also the unsettled-boot marks the boot watchdog reads instead of every worktree's boot channel (markBootUnsettled, written by the serving entry point beside the boot's start line).",
  register: [bootCrashRegistration],
  onReady: () => {
    disarmBootCrash();
  },
} satisfies MachinePluginDefinition;
