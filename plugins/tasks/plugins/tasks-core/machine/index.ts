import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PushLedger } from "@plugins/tasks/plugins/tasks-core/server";
import { ensurePushLedgerFresh } from "./internal/push-ledger/freshness";
import { pushLedgerReaction } from "./internal/push-ledger/reaction";

export default {
  description:
    "The desktop's push ledger: re-derives `pushes` from main's git history — on read and at boot (PushLedger, memoized on main's tip and the attributable conversation set) and the instant refs/heads/main moves (an in-process ref reaction).",
  register: [pushLedgerReaction],
  contributions: [
    PushLedger.provide({
      ensureFresh: async () => {
        await ensurePushLedgerFresh();
      },
    }),
  ],
} satisfies MachinePluginDefinition;
