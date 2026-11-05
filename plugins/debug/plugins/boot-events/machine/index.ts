import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootCrashRegistration, disarmBootCrash } from "./internal/boot-crash";
import { bootMarkRegistration } from "./internal/unsettled-marks";

export {
  clearBootUnsettled,
  markBootUnsettled,
  readBootUnsettled,
  stampBootUnsettledIndexed,
} from "./internal/unsettled-marks";

export default {
  description:
    "Boot crashes as reports, desktop-only half: until the backend is ready, an uncaught throw or rejection is printed, filed as a crash report (error, stack, and the checkout's merge-base with the stack's repo files for the staleness rule) through the report outbox main drains, and the process exits 1 — the reports engine's own crash hooks install only once it is ready. Also marks the worktree's boot unsettled at the register phase (the unsettled-boot marks the boot watchdog reads instead of every worktree's boot channel).",
  register: [bootCrashRegistration, bootMarkRegistration],
  onReady: () => {
    disarmBootCrash();
  },
} satisfies MachinePluginDefinition;
