import {
  installMemoHolds,
  type MemoHolder,
  type MemoHolds,
} from "@plugins/packages/plugins/shared-work/core";

/**
 * How long a check pass keeps what its checks memoized: while a check that
 * read it still runs (`packages/shared-work`'s memo holds).
 *
 * Every per-run memo of a pass (the codegen trees, the evaluated barrels, the
 * source analysis, the masks — `sharedMemo` and `heldValueMemo`) used to live
 * until the pass ended: keyed by the run's one file set, which the runner
 * holds to the end. The pass's checks are of very different lengths, and the
 * type-check runs alone for minutes after the rest settle — holding ~1 GB of
 * live heap (2 GB resident) that only finished checks had read, beside its
 * own 4–5 GB batches (research/2026-11-19-global-check-pass-memory-release.md).
 *
 * So each check runs under a holder of its own ({@link PassHolds.forCheck}),
 * every memo entry it reads is held by it, and it lets go when the check
 * settles. Until every selected check has started, the pass holds every entry
 * a check read too: a check still queued (`--jobs`) would otherwise make again
 * what one that already finished made. An entry held by nothing is the
 * collector's; a check that asks for it later makes it again, off the records
 * the first making wrote.
 */

// Installed by the first pass, never on import: a build or a test process
// loads this module through the checks barrel, and holds installed where no
// unit ever runs would pin every entry for the life of that process. The
// context is the host's (an AsyncLocalStorage in the check command): `core/`
// runs on every host, and carries no async-context API of its own.
let installed: MemoHolds | undefined;
function installOnce(context: MemoHolds): void {
  if (installed === context) return;
  if (installed !== undefined)
    throw new Error(
      "[checks] a second check pass in this process brought another memo context: one tracks the holds of every pass",
    );
  installed = context;
  installMemoHolds(context);
}

/** One check's holder: holds what the check reads until {@link release}. */
export interface CheckHolder extends MemoHolder {
  /** Let go of everything the check held: called when the check settles. */
  release(): void;
}

export interface PassHolds {
  /** A holder for one check, current while `run` runs its body. */
  forCheck(): CheckHolder;
  /** Run a check's body (its async continuations included) under `holder`. */
  run<T>(holder: CheckHolder, fn: () => T): T;
  /**
   * Every selected check has started: the pass stops holding what checks
   * read, so an entry lives only while a running check holds it.
   */
  admissionClosed(): void;
}

/**
 * The holds of one pass (`runChecks`), over the host's async context
 * (`RunChecksOptions.memoContext`): `current()` is the holder of the running
 * code, `run(holder, fn)` runs a body under one.
 */
export function openPassHolds(context: MemoHolds): PassHolds {
  installOnce(context);
  let admission: Set<object> | null = new Set();
  return {
    forCheck() {
      let held: Set<object> | null = new Set();
      return {
        hold(entry) {
          // A continuation the check left running after it settled (work it
          // never awaited) holds nothing: the check is over.
          held?.add(entry);
          admission?.add(entry);
        },
        release() {
          held = null;
        },
      };
    },
    run: (holder, fn) => context.run(holder, fn),
    admissionClosed() {
      admission = null;
    },
  };
}
