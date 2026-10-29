import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PushLedger } from "@plugins/tasks/plugins/tasks-core/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { ensurePushLedgerFresh } from "./internal/push-ledger/freshness";
import { pushLedgerReaction } from "./internal/push-ledger/reaction";

export default {
  description:
    "The desktop's push ledger: re-derives `pushes` from main's git history — on read and at boot (PushLedger, memoized on main's tip and the attributable conversation set) and the instant refs/heads/main moves (an in-process ref reaction).",
  register: [pushLedgerReaction],
  contributions: [
    PushLedger.provide({
      // Its own `bg` span, so a caller's loader span captures none of the
      // reconcile's reads or writes: a live value pulling the ledger current
      // (attempt-work) is judged on its own reads (its follows), and the
      // ledger's inserts reach it through the feed like any write.
      ensureFresh: () =>
        runTracked("push-ledger.reconcile", async () => {
          await ensurePushLedgerFresh();
        }),
    }),
  ],
} satisfies MachinePluginDefinition;
