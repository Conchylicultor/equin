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
  /**
   * Resolves once the ledger covers `main` as git holds it NOW — not as this
   * host's ref watcher last heard it, which trails a push by however late the
   * file event arrives. For a write whose derived status reads the ledger at
   * once: closing a conversation (or losing its process) turns a `pushed`
   * attempt `completed` only if its push row is already there, so the close
   * pulls the ledger current first — otherwise the task reads `attempted`
   * ("its agent ended without landing") until the watcher catches up
   * (task-1794187243-6jyy8o). Throws like `ensureFresh`.
   */
  ensureCurrent(): Promise<void>;
}

export const PushLedger = defineHostService<PushLedgerImpl>(
  "tasks-core.push-ledger",
);
