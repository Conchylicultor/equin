import type { Namespace } from "@plugins/infra/plugins/namespace/core";

/** What {@link runAttached} runs: one command, as one run of one kind. */
export interface AttachedRun {
  namespace: Namespace;
  kindId: string;
  runId: string;
  argv: string[];
  cwd?: string;
  /** The child's full environment (its marker path is added). */
  env: Record<string, string | undefined>;
}

/**
 * Run a command as a supervised run of kind `kindId` WITH ITS CALLER ATTACHED —
 * a hand-typed `./equin build` — so it leaves exactly the record a run the
 * backend starts leaves: the transcript (`runs/<kind>-<id>.log`, stdout and
 * stderr merged, written by the child straight into the file) and the exit
 * marker (`.exit-code`, `<status> <signal-or-dash>`). The caller sees the
 * output live, echoed from the transcript, and exits with the returned status.
 *
 * The differences from the backend's spawn are what "attached" means:
 *
 * - **Not detached.** The child is in the caller's process group, so a Ctrl-C
 *   or a group kill reaches it directly, and a caller that exits SIGTERMs it
 *   (infra/spawn's live-children) — an abandoned build must not hold the build
 *   lock, which is why `build` is not `detachable`.
 * - **This process writes the marker**, not the shim: it is the child's parent
 *   and waits on it, so it observes the same two facts — the status, and the
 *   signal that arrived while it waited (relayed to the child, then recorded,
 *   as the shim's trap records it). A SIGKILL of this process writes none,
 *   which reads as the hard kill it is.
 * - **The echo is a tail of the transcript**, heard through a `writesWhileOpen`
 *   follow of the transcript file (the child holds it open; FSEvents would report
 *   it only at close) — the file is the one record, so the terminal shows what
 *   a reader of the run will see, never a second copy that could differ.
 */
export async function runAttached(opts: AttachedRun): Promise<number> {
  // Deferred: this module is reached through the `cli` barrel, which is also
  // the `supervised-exec` declaration every invocation loads
  // (`cli:command-declarations-light`).
  const { runAttachedNow } = await import("./attached-run");
  return runAttachedNow(opts);
}
