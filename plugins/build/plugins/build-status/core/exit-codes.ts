/**
 * A build of main reads the shared main worktree for minutes (codegen, checks,
 * vite) while `./equin push` is free to merge into that same tree. When a
 * merge lands mid-build, every source read after it answers for a different
 * commit than the reads before it — so the build's verdict is about no coherent
 * tree at all, and whichever `*-in-sync` check straddles the swap reports drift
 * on a tree that is perfectly in sync.
 *
 * That is not a failure, and must never be reported as one: the build simply no
 * longer has a subject. It exits with this code, which the run ledger renders as
 * its own `superseded` status rather than red. The rebuild is guaranteed
 * separately — `reconcileDeployment` (build/server) re-derives "is this
 * checkout's HEAD what is deployed" the moment any build reaches terminal.
 *
 * 75 is EX_TEMPFAIL from sysexits.h: "temporary failure, the user is invited to
 * retry" — exactly this. Deliberately not 0 (nothing was deployed, so a caller
 * that reads 0 as "my change is live" would be wrong) and not -1, which the
 * ledger already spends on a hard-killed owner of unknown outcome.
 */
export const BUILD_EXIT_SUPERSEDED = 75;

/**
 * The exit code the ledger writes for a run whose owning process was hard-killed
 * by a newer build's restart. Deliberately outside the 0-255 wait status range,
 * so it can never collide with a code the build itself chose.
 */
export const BUILD_EXIT_HARD_KILLED = -1;

/**
 * POSIX shell convention: a process terminated by signal N reports 128 + N. The
 * CLI's own fatal-signal handlers already produce exactly this (SIGHUP → 129,
 * SIGINT → 130, SIGQUIT → 131, SIGTERM → 143), so no new constant is needed to
 * recognise an externally-killed build.
 *
 * ## The precondition that makes reading `exitCode > 128` as "killed" legal here
 *
 * Elsewhere in this repo that read is banned outright, and for a good reason: a
 * shell reports a signalled child as `128 + signo`, so for an ARBITRARY command
 * `143` cannot be told apart from a program that chose `exit(143)` — which is
 * what recorded a killed deploy as `Exited with code 143`, a sentence about a
 * command that never exited and never refused. The supervised-run primitive
 * exists partly to replace that guess with an observation (`RunTerminal.
 * signalCode`, set by its shim's trap having fired) and states flatly that
 * nothing may re-derive killed-ness from the status.
 *
 * **`buildStatusOf` is not an exception to that rule; it is outside its
 * premise.** The premise is a command whose codes we do not author. These codes
 * are FIRST-PARTY: `./equin build` installs `installFatalSignalExit` and
 * *chooses* `128 + signo` for itself, from `FATAL_SIGNAL_EXITS`, having caught
 * the signal. So the number here is a record the build wrote about a signal it
 * saw, not a wait status somebody decoded afterwards.
 *
 * That precondition is the whole licence, so it is written down rather than
 * assumed: **the moment `build_runs.exit_code` can carry a status this repo did
 * not author, this reading becomes the banned inference and must be replaced by
 * an observed signal.** (One is available — the supervised-run marker records
 * it — and the only reason it is not consulted is that the table has nowhere to
 * put it and the CLI's own code already answers.)
 *
 * Exported alongside the other two because `buildStatusOf` is not the only place
 * the rule is written any more: the `runs` build arm compiles the SAME rule into
 * SQL, and the one thing that must never differ between the two encodings is the
 * numbers they compare against.
 */
export const BUILD_EXIT_SIGNAL_BASE = 128;
