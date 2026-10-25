// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` and resolves per-worktree paths. It lives in `core/` so a CLI
// process — which cannot reach a `server/` barrel — can read the same exit
// marker the backend reads, rather than re-deriving the format. It must NEVER
// be imported from `web/`, and it deliberately touches no `db` and no jobs
// queue: what is here is the file format, the process probe and the close rule
// built from the two, nothing else.
//
// The `supervised-exec` verb's name and the shape of one child invocation live
// here too, because the CLI declaration (`cli/`) spells the name and `server/`
// produces invocations. The declaration imports that one file directly rather
// than this barrel, so it never pays for `node:fs` — see `cli/index.ts`.

export {
  HARD_KILL_EXIT_CODE,
  isRunAlive,
  observeRun,
  readRunTerminal,
  RunMarkerError,
} from "./internal/terminal";
export type { RunObservation, RunTerminal } from "./internal/terminal";
export { supervisedArgv, RUN_TERMINAL_ENV } from "./internal/shim";
export { assertRunKindId, assertRunId, isRunId } from "./internal/ids";
export { SUPERVISED_EXEC_COMMAND } from "./internal/exec-command";
export type { ExecContext } from "./internal/exec-context";
export type { SupervisedTaskInvocation } from "./internal/exec-command";
