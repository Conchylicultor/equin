import { z } from "zod";

import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

// Until the turn ledger, this plugin kept its own record of every send in
// localStorage, one key per conversation. Nothing reads those keys now; the
// store below exists only for its `legacy` match: its first touch deletes them,
// once per page load, so they do not sit in every user's storage forever.
// Safe to delete this module once no browser can still hold one.
const retiredPendingTurns = defineStore({
  owner: "pending-turn.retired",
  label: "Retired pending turns",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.never(),
  legacy: { match: (key) => key.startsWith("singularity:pending-turns:") },
});

export const dropLegacyPendingTurns: NonNullable<
  PluginDefinition["register"]
>[number] = {
  register() {
    retiredPendingTurns.ids();
  },
};
