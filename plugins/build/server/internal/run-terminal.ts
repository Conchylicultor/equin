import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import {
  RUN_TERMINAL_SUFFIX,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import { readRunTerminal } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import {
  BUILD_RUN_KIND_ID,
  buildRunIdKind,
  type BuildRunId,
} from "@plugins/build/plugins/run-ledger/core";

// "A build run has ended, and everything it will ever write is on disk" — the
// change signal for live values over a run's artifacts (its step logs, its
// profile, its termination record).
//
// **Why the exit marker and never the ledger row.** `./singularity build`
// (`framework/cli/plugins/build/cli/run.ts`) closes its own `build_runs` row
// BEFORE it writes its artifacts: the success path runs `recorder.closeRun`,
// then `writeBuildProfile`, then `writeBuildLogs`, and the failure funnel writes
// the logs and then closes the row — with ~100 s of compose-serve tail after the
// close either way. A value recomputed on the row's close would read "no logs /
// no profile" and keep it. The exit marker cannot be early: the supervised-run
// shim writes it (tmp + rename) after `wait` on the CLI returned, and every
// artifact the CLI writes is written synchronously by that process before it
// exits — the step logs and profile by `writeFileSync` + `renameSync`, the
// termination line by the signal handler / exit hook, where nothing may be
// awaited. So marker on disk ⇒ every artifact on disk.
//
// A run hard-killed with its shim (SIGKILL to the group) leaves no marker at
// all; the supervised-run close rule decides it ended once its process group is
// empty, and both places that act on that decision announce here too
// (`closeBuildRow` in the reconciler, `onBuildEnded` in the workflow). With the
// group empty nothing is left to write anything, so that announcement is as
// honest as the marker's.
//
// A run that ended before this process started is never announced — there is
// no edge left to report. A reader decides it from the marker itself
// (`readRunTerminal(BUILD_RUN_KIND_ID, runId)`): present ⇒ its artifacts are
// final.

/**
 * The build runs dir watcher: notices a build's exit marker landing, in any
 * backend of this namespace — including one that never tracked the run (it
 * booted after the CLI had already closed its row), which the supervised-run
 * reconciler would only reach on its next bounded wake.
 */
export const buildRunTerminalWatcher = defineFileWatcher({
  name: "build.run-terminal",
  description:
    "Notices a build's exit marker landing so the run's logs, profile and termination record refresh the moment the build ends.",
  extensions: [RUN_TERMINAL_SUFFIX],
});

/**
 * The run a marker filename belongs to, when it is a build's — the inverse of
 * `worktreeArtifacts.runTerminal(ns, BUILD_RUN_KIND_ID, runId)`. `null` for
 * another kind's marker, or a name that is no build run id.
 */
export function buildRunIdOfMarker(filename: string): BuildRunId | null {
  const prefix = `${BUILD_RUN_KIND_ID}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith(RUN_TERMINAL_SUFFIX))
    return null;
  const runId = filename.slice(prefix.length, -RUN_TERMINAL_SUFFIX.length);
  return buildRunIdKind.is(runId) ? runId : null;
}

/** Listeners plus the arm-once of whatever feeds them. */
export interface RunTerminalHub {
  /** Hear every announced run; resolves once the feed is armed. */
  on(listener: (runId: BuildRunId) => void): Promise<() => void>;
  /** A run ended with everything on disk — tell every listener. */
  announce(runId: BuildRunId): void;
}

export function createRunTerminalHub(arm: () => Promise<void>): RunTerminalHub {
  const listeners = new Set<(runId: BuildRunId) => void>();
  let armed: Promise<void> | null = null;
  return {
    async on(listener) {
      listeners.add(listener);
      armed ??= arm();
      const arming = armed;
      try {
        await arming;
      } catch (err) {
        // Not cached: the next subscriber tries to arm it again. Only this
        // attempt is forgotten — never a newer one.
        if (armed === arming) armed = null;
        listeners.delete(listener);
        throw err;
      }
      return () => {
        listeners.delete(listener);
      };
    },
    announce(runId) {
      // Every listener runs even when one throws; the first failure is rethrown
      // after, so one consumer's bug neither starves the others nor vanishes.
      let failure: { error: unknown } | null = null;
      for (const listener of [...listeners]) {
        try {
          listener(runId);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== null) throw failure.error;
    },
  };
}

const hub = createRunTerminalHub(async () => {
  const dir = worktreeArtifacts.runsDir(runtimeNamespace());
  await mkdir(dir, { recursive: true });
  // Armed for the life of the process once anyone listens: one FSEvents
  // subscription over a flat, pruned directory, filtered to markers.
  await buildRunTerminalWatcher.start({
    dirs: [dir],
    onChange: (events) => {
      const ended = new Set<BuildRunId>();
      for (const event of events) {
        if (event.type === "delete") continue; // the artifact prune
        const runId = buildRunIdOfMarker(basename(event.path));
        // Re-read the marker rather than trust the event: it is the authority,
        // and a malformed one throws (RunMarkerError) — a writer defect.
        if (runId !== null && readRunTerminal(BUILD_RUN_KIND_ID, runId))
          ended.add(runId);
      }
      for (const runId of ended) hub.announce(runId);
    },
  });
});

/**
 * Be told when a build run of this namespace ENDS with every artifact it will
 * write on disk — its exit marker landed (see this file's header for why that
 * implies the logs, the profile and the termination record), or it was
 * hard-killed with nothing left to write.
 *
 * Resolves with the unsubscribe once the marker watcher is armed, so a reader
 * that subscribes (e.g. from `whileSubscribed`) and THEN reads the run cannot
 * miss an end that lands in between. A run may be announced more than once
 * (the marker, the reconciler's close, the workflow's wake): listeners must be
 * idempotent — a `notify` is.
 *
 * Covers supervised runs only — the ones the backend started. A hand-run
 * `./singularity build` has no shim and therefore no exit marker, and is never
 * announced.
 */
export function onRunTerminal(
  listener: (runId: BuildRunId) => void,
): Promise<() => void> {
  return hub.on(listener);
}

/** Announce a run the supervised-run close rule decided has ended. */
export function announceRunTerminal(runId: string): void {
  hub.announce(buildRunIdKind.key(runId));
}
