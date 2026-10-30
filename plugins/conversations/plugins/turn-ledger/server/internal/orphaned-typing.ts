import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { failOrphanedTypingTurns } from "./store";

// When this process loaded: every `typing` row last moved before it was being
// sent by a process that is gone. A row this process starts sending moves
// after it, so the warm-up — deferred past serving-ready — never fails a send
// in flight.
const bootedAt = new Date();

// `worktree` scope: the ledger lives in each backend's own DB, and a fork
// inherits its source's rows, orphans included.
export const orphanedTypingWarmup = defineWarmup({
  name: "turn-ledger.orphaned-typing",
  description:
    "Fails the turns a previous backend process was still sending when it died, so none reads as a turn its agent is about to start.",
  scope: "worktree",
  run: async () => {
    await failOrphanedTypingTurns(bootedAt);
  },
});
