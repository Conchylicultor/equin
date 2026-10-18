import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/**
 * Who keeps `pushes` covering `main` — the PULL half of the ledger's freshness
 * (see the tasks-core CLAUDE.md, "Push ledger"). The ledger is a projection of
 * `main`'s trailer-bearing git history, so re-deriving it needs the computer:
 * the desktop's provider (`tasks-core#machine`) walks `main` and inserts what
 * landed, behind a memo signed on `main`'s tip. A host without git has no
 * history to project, so there the rows it was seeded with ARE the ledger, and
 * its provider has nothing to do.
 */
export interface PushLedgerImpl {
  /**
   * Resolves once the ledger covers `main` as this host last observed it.
   * Throws when the history or the database is unreadable: a caller must
   * never be handed a ledger that silently failed to catch up.
   */
  ensureFresh(): Promise<void>;
}

export const PushLedger = defineHostService<PushLedgerImpl>(
  "tasks-core.push-ledger",
);
