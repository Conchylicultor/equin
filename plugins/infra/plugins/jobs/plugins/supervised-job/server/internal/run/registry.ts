import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { LogChannel } from "@plugins/primitives/plugins/log-channels/server";
import { assertRunKindId, type RunTerminal } from "../../../core";

/** One unfinished run, as the kind's own ledger knows it. */
export interface UnfinishedRun {
  readonly runId: string;
  /**
   * The process the run belongs to, or `null` when the row was claimed but
   * never got a pid. Null reads as dead — a claim with no process behind it is
   * a corpse holding the kind's in-flight lock, and leaving it open is how that
   * lock wedges forever.
   */
  readonly pid: number | null;
}

/**
 * The adapter between this primitive and ONE consumer's ledger table.
 *
 * Each consumer keeps its own table — `build_runs`, `release_runs` and
 * `deploy_runs` carry genuinely different domain columns and merging them would
 * be wrong — so the primitive never names a consumer and never touches `db`.
 * It knows four verbs and a channel; everything domain-shaped stays with the
 * caller (collection-consumer separation).
 */
export interface SupervisedRunKindSpec {
  /**
   * Stable identity, and the filename prefix of every artifact this kind
   * writes. Lowercase alphanumeric, no separator — see `assertRunKindId`.
   */
  readonly id: string;
  /** Where the supervisor publishes this kind's live output. */
  readonly channel: LogChannel;
  /**
   * Every row of this kind that has not been stamped with an outcome, in THIS
   * namespace. Scoping is the caller's job and it matters: a worktree DB is a
   * fork of main's, so a kind that hands back main's inherited rows would have
   * this primitive reap another machine's runs and surface phantom failures in
   * every worktree.
   */
  listUnfinished(): Promise<readonly UnfinishedRun[]>;
  /** Record the pid of the process now serving `runId`. */
  setPid(runId: string, pid: number): Promise<void>;
  /**
   * The run has ENDED. Stamp the terminal outcome, and do whatever else this
   * kind hangs off a run finishing.
   *
   * **It is called for a run whose ledger row is already closed, and that is the
   * ordinary case, not an edge.** A kind whose own CLI stamps its row does so
   * while its process is still running — `./equin build` closes its row
   * after the health probe and then runs for another ~100s — so by the time the
   * exit marker lands, `listUnfinished` stopped naming this run minutes ago. The
   * primitive still calls this, because the row being written is not the run
   * being over, and a consumer's terminal work (a notification, a convergence
   * reconcile) has no other edge to hang from.
   *
   * Two consequences for an implementation:
   *
   * - **The write must be first-writer-wins** (`WHERE finished_at IS NULL`), so
   *   it never overwrites the caller's own authoritative close.
   * - **Anything BESIDE the write must still be safe to run against a row that
   *   is already stamped** — read the row back rather than assuming this call
   *   is what closed it.
   *
   * Called at most once per run by this primitive.
   */
  finish(runId: string, terminal: RunTerminal): Promise<void>;
  /**
   * A run this process did not start has been adopted: rebuild whatever
   * in-memory live view the kind keeps for it.
   *
   * Optional because a kind whose UI reads only the DB row plus the log channel
   * needs nothing — the supervisor has already restarted the transcript tail by
   * the time this is called, so the output is flowing again either way. It
   * exists for a kind holding a `Map` of live runs (deploy's `run-state.ts`),
   * which is state the process lost and only it can restore. Rebuilt from
   * durable state on every boot, never persisted — the `op-status` /
   * `prototypes/thumbnails` idiom of state that is "free to rebuild at boot,
   * and impossible to leave stale".
   */
  onReattach?(runId: string): void;
}

/**
 * A registered kind. The token a consumer mounts via `register: [kind]` on its
 * `ServerPluginDefinition`, and the handle it passes to `startSupervisedRun`.
 *
 * A `register:` token rather than a side effect at module eval, and for a
 * reason the reconciler depends on: the framework runs every plugin's register
 * phase to completion BEFORE any plugin's `onReady`, so this plugin's own
 * `onReady` is guaranteed to see the complete set of kinds. `defineJob` has the
 * same shape for the same reason.
 */
export interface SupervisedRunKind extends Registration {
  readonly id: string;
  readonly spec: SupervisedRunKindSpec;
}

const kinds = new Map<string, SupervisedRunKind>();

export function defineSupervisedRunKind(
  spec: SupervisedRunKindSpec,
): SupervisedRunKind {
  // At definition, not at registration: a malformed id is a coding error, and
  // failing at module eval names the file that wrote it.
  assertRunKindId(spec.id);
  const kind: SupervisedRunKind = {
    id: spec.id,
    spec,
    _kind: "supervised-run-kind",
    _factory: "defineSupervisedRunKind",
    _doc: { label: spec.id },
    register() {
      const existing = kinds.get(spec.id);
      if (existing !== undefined && existing !== kind) {
        throw new Error(
          `[supervised-run] duplicate kind id: ${spec.id} — two kinds sharing an ` +
            `id would share an artifact prefix, so each would reap the other's ` +
            `transcripts.`,
        );
      }
      kinds.set(spec.id, kind);
    },
  };
  return kind;
}

/** Every registered kind, for the one reconciler that serves all of them. */
export function getSupervisedRunKinds(): readonly SupervisedRunKind[] {
  return [...kinds.values()];
}

/**
 * The kind registered under `id`, or undefined. The one way a kind id read off
 * a FILENAME becomes a kind — so a stray file in the run-artifact directory
 * cannot mint a run for a kind nobody registered.
 */
export function getSupervisedRunKind(
  id: string,
): SupervisedRunKind | undefined {
  return kinds.get(id);
}

/**
 * Assert that `kind` is the registered kind for its id.
 *
 * Called on the way into `startSupervisedRun` so a consumer that defined a kind
 * but forgot to mount it (`register: [kind]`) fails at the spawn rather than
 * silently starting a run that this plugin's `onReady` will never reconcile —
 * a run whose row stays open forever after any restart. Loud at the one call
 * site that could have got it wrong, rather than a symptom hours later.
 */
export function assertRegistered(kind: SupervisedRunKind): void {
  if (kinds.get(kind.id) !== kind) {
    throw new Error(
      `[supervised-run] kind "${kind.id}" is not registered — add it to ` +
        `\`register: [...]\` on its plugin's ServerPluginDefinition. An ` +
        `unregistered kind is never reconciled, so its rows would stay open ` +
        `forever after a restart.`,
    );
  }
}
