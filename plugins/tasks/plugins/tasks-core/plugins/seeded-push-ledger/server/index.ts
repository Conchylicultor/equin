import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PushLedger } from "@plugins/tasks/plugins/tasks-core/server";

export default {
  description:
    "The push ledger of a host without git: provides the PushLedger host service as nothing to do — there is no main history to project, so the `pushes` rows the database was seeded with ARE the ledger (the browser composition, the portable boot test). Never booted by the desktop.",
  portable: true,
  contributions: [PushLedger.provide({ ensureFresh: async () => {} })],
} satisfies ServerPluginDefinition;
