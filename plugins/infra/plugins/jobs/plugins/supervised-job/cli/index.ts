import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
// The one file, not the `core/` barrel: the barrel also carries the exit-marker
// reader (`node:fs`, per-worktree paths), which a declaration loaded on every
// invocation has no business evaluating.
import { SUPERVISED_EXEC_COMMAND } from "../core/internal/exec-command";

// The CLI mint of an ExecContext (see core/internal/exec-context.ts). It lives in
// this `cli` barrel on purpose: no `server/` file may import a `cli` barrel, so a
// request handler has no way to spell it. Its host admission is a deferred
// import, so the declaration stays light.
export { cliExecContext } from "./internal/cli-exec-context";

/**
 * The child half of a supervised task: boot the plugin graph in `exec` mode,
 * run ONE registered task, exit with its status.
 *
 * Not a verb anyone types. It exists because the supervisor
 * (`server/internal/run/`) supervises an ARGV, and a `run` body has no argv of
 * its own — so this is the argv that stands for one. The job's registered task
 * (`server/internal/run-body.ts`) builds the invocation; nothing else should write this command line by hand,
 * which is why the payload is positional JSON rather than a set of flags: there
 * is no ergonomics to serve, only a round-trip to keep exact.
 *
 * `detachable`, and it is not optional. A supervised child is spawned detached
 * and is MEANT to outlive the backend that started it — that is the whole point
 * of the primitive. The orphan guard is armed for every invocation and exits a
 * command whose invoking shell went away, which for this command would kill the
 * very run the design exists to preserve.
 *
 * This file loads on EVERY `./equin` invocation (commander needs names and
 * flags before it parses argv), so it imports the verb's own name and
 * `defineCliCommand` and nothing else; `runExec` and the task registry sit
 * behind the deferred `run: () => import(…)`. `cli:command-declarations-light`
 * measures that closure.
 */
export default defineCliCommand<[string, string], { namespace: string }>({
  name: SUPERVISED_EXEC_COMMAND,
  description:
    "Run one registered supervised task in a booted `exec` runtime, then exit " +
    "with its status. Spawned by defineSupervisedJob's `run` body — not a verb " +
    "to type by hand.",
  arguments: [
    {
      name: "<taskId>",
      description: "Name of a supervised job declared with a `run` body",
    },
    {
      name: "<payloadJson>",
      description:
        "The task's payload as one JSON argument, parsed against its own schema",
    },
  ],
  options: [
    {
      // REQUIRED, so commander refuses an invocation without it rather than the
      // child discovering it 83 plugins deep. It names the namespace this exec
      // runtime serves — its plugin registry and its database — and only the
      // backend that spawned the child knows which that is. It used to be
      // inherited through the environment, which is exactly what made a
      // hand-typed invocation silently talk to main's database.
      flags: "--namespace <ns>",
      description:
        "The namespace this exec runtime boots as — its plugin registry and its database",
      required: true,
    },
  ],
  detachable: true,
  run: () => import("./run"),
});
