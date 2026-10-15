import { z } from "zod";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { declaredDep, ensureDep, type Dep, type DepSource } from "../../deps";

// The installs' transcripts, at `logs/deps-install.jsonl` of the backend that
// supervises them (the child's own output, tailed).
const depsInstallLog = defineLogSink({
  id: "deps-install",
  description:
    "Dependency installs requested from the app (Settings → Dependencies, a feature's first use): each install's progress and its installer's output.",
});

/**
 * Install one declared dependency, in a detached child
 * (`./singularity supervised-exec deps.install`): a Python env is hundreds of
 * MB of downloads that must neither block a backend's event loop nor die with a
 * restart.
 *
 * `lock` is the dep id, so a second request while one installs claims nothing
 * and returns. `ensureDep` itself is idempotent and takes the host flock, so a
 * CLI install of the same identity running meanwhile is waited for, not
 * duplicated.
 */
export const depsInstallJob = defineSupervisedJob({
  name: "deps.install",
  description:
    "Downloads and installs one optional dependency in the background so it is ready when a feature needs it.",
  input: z.object({ id: z.string() }),
  channel: depsInstallLog,
  lock: ({ id }) => id,
  async run({ id }, { log, exec }) {
    await ensureDep(await declaredDep(id), exec, { log });
  },
  // Push, not poll: whoever answered "not installed yet" on a request path
  // (and so asked for this install) re-reads once it has settled, whichever
  // way it went — `readyNow` then says `ready` or `failed`.
  onEnded: async (_runId, _terminal, { input }) => {
    for (const listener of settledListeners.get(input.id) ?? []) listener();
  },
});

const settledListeners = new Map<string, Set<() => void>>();

/**
 * Call `listener` each time a `deps.install` run of `dep` requested from THIS
 * backend ends — installed or failed; read `readyNow` / `depState` to learn
 * which. For a request path that answered "not available yet" (and called
 * `requestDep`) to resume on its own when the install lands. Returns the
 * unsubscribe.
 *
 * An install run from a terminal (`./singularity deps install`) is not seen
 * here — but a `requestDep` made while one runs is: its job waits on the same
 * host lock and ends right after.
 */
export function onDepInstallSettled(
  dep: Dep<DepSource>,
  listener: () => void,
): () => void {
  let set = settledListeners.get(dep.id);
  if (set === undefined) {
    set = new Set();
    settledListeners.set(dep.id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Ask for `dep` to be installed, from anywhere — a request handler included.
 * Enqueues the `deps.install` job and returns at once; the install's progress
 * shows on `depState` / the `deps.states` live value.
 */
export async function requestDep(dep: Dep<DepSource>): Promise<void> {
  await depsInstallJob.enqueue({ id: dep.id });
}
