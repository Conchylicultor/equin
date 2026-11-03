import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { bootCrashRegistration, disarmBootCrash } from "./internal/boot-crash";

export default {
  description:
    "Boot crashes as reports, desktop-only half: until the backend is ready, an uncaught throw or rejection is printed, filed as a crash report (error, stack, and the checkout's merge-base with the stack's repo files for the staleness rule) through the report outbox main drains, and the process exits 1 — the reports engine's own crash hooks install only once it is ready.",
  register: [bootCrashRegistration],
  onReady: () => {
    disarmBootCrash();
  },
} satisfies MachinePluginDefinition;
