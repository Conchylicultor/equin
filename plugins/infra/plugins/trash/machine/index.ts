import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { trashPurge } from "./internal/purge";

export default {
  description:
    "Trash, desktop-only half: the 30-day purge sweep (a nightly retention job over trash_entries, running each source's purge before the ledger rows go).",
  register: [trashPurge],
} satisfies MachinePluginDefinition;
