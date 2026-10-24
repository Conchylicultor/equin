/**
 * The environment variable the shim reads its marker path out of. Passed via
 * the environment rather than interpolated into the script so a path containing
 * a quote, a space or a `$` cannot rewrite the script itself.
 */
export const RUN_TERMINAL_ENV = "SUPERVISED_RUN_TERMINAL";

/**
 * `$0` for the shim shell. It is what `sh` prefixes its own diagnostics with,
 * so a command that does not exist reports
 * `supervised-run: /no/such/binary: No such file or directory` into the
 * transcript instead of a bare `sh:`.
 */
const SHIM_ARGV0 = "supervised-run";

/**
 * The one-line POSIX shim that records the child's status.
 *
 * ```sh
 * trap 'g=TERM; i=1' TERM; trap 'g=INT; i=1' INT; trap 'g=HUP; i=1' HUP
 * "$@" & c=$!
 * wait "$c"; s=$?
 * while [ "$i" = 1 ] && kill -0 "$c" 2>/dev/null; do i=0; wait "$c"; s=$?; done
 * [ -n "$g" ] || g=-
 * printf '%s %s\n' "$s" "$g" > "$T.tmp.$$" && mv "$T.tmp.$$" "$T"; exit "$s"
 * ```
 *
 * Why the primitive wraps the argv rather than teaching each command to record
 * its own status: build's artifact works only because the build CLI cooperates,
 * and deploy's and release's CLIs do not. Three CLIs learning the same trick is
 * three places to get it right and three places for it to rot — which is
 * exactly what happened to release, whose recovery artifact only the parent
 * ever wrote, so a genuinely orphaned release had nothing to read. A wrapper
 * works for **any** command, including one this repo does not own.
 *
 * Every clause earns its place:
 *
 * - **`"$@"`** runs the argv as separate words, so an argument containing
 *   spaces or quotes is passed through untouched. The argv arrives as real
 *   argv (after `$0`), never interpolated into the script text, so there is no
 *   quoting to get wrong and no injection to worry about.
 * - **`& c=$!` … `wait "$c"`** runs the child in the background and waits,
 *   instead of the obvious foreground `"$@"`. A foreground child gives `sh` no
 *   chance to react: the default disposition of SIGTERM terminates the shell
 *   outright, so a group signal would leave no marker and a *cancelled* run
 *   would be indistinguishable from a hard kill.
 * - **The traps are installed BEFORE the `&`**, not after — see the comment on
 *   the script itself. The gap between them is a window with the default
 *   disposition still in place.
 * - **One trap per signal, each recording its own NAME**, rather than a single
 *   `trap : TERM INT HUP`. The bare null command is enough to make `wait`
 *   return, but it throws away the one fact only the shell has: that a signal
 *   arrived at all. See {@link supervisedArgv}'s note on why that fact cannot
 *   be recovered from the status afterwards.
 * - **The `wait` is retried** while a signal fired and a child remains, because
 *   a trapped signal makes `wait` return *before* the child has exited. Again,
 *   see the comment on the script.
 * - **`$?` captured into `s` immediately** — every later command overwrites it.
 * - **`[ -n "$g" ] || g=-`** writes a literal `-` for "no signal seen", so the
 *   marker always has exactly two fields and the parser can be strict.
 * - **tmp + `mv`** is `rename(2)` within one directory, so a reader never sees
 *   a partial marker. `$$` in the temp name matches the repo's
 *   `<path>.tmp.<pid>` convention, which is what lets the artifact prune
 *   recognise and sweep a crashed write.
 * - **`exit "$s"`** hands the child's status back to anyone still waiting on
 *   the shim (the spawning backend, when it survives), so the pid-based path
 *   and the marker-based path agree.
 *
 * A SIGKILL runs none of this, which is the point: no marker then means the
 * child was hard-killed, and that is the only thing it can mean.
 */
const SHIM_SCRIPT = [
  // BEFORE the child is backgrounded. Between `&` and the first `trap` the
  // shell still has SIGTERM's default disposition, and a group signal landing
  // in that window kills it outright — no marker, and a clean cancel is then
  // recorded as a hard SIGKILL. The window is microseconds; closing it costs
  // nothing. Safe to install first because a signal trapped to a HANDLER is
  // reset to the default in the child (only `trap ''` — ignore — is inherited),
  // so the child's own disposition is unchanged either way.
  //
  // One trap per signal so the HANDLER names it. `$g` is the only place the
  // "was signalled" fact survives — `$?` cannot carry it (see supervisedArgv).
  // `$i` says a signal arrived DURING the wait below.
  "trap 'g=TERM; i=1' TERM;",
  "trap 'g=INT; i=1' INT;",
  "trap 'g=HUP; i=1' HUP;",
  '"$@" &',
  "c=$!;",
  // Unconditional, so `$s` is always set no matter what the loop below decides.
  'wait "$c";',
  "s=$?;",
  // A trapped signal makes `wait` return 128+signo IMMEDIATELY — the child has
  // NOT necessarily exited. Recording that and leaving would report a terminal
  // outcome while the real work is still running (reparented, unwatched), and
  // would throw away the status the child is about to produce. So: wait again
  // whenever a signal fired and there is still a child to wait for. Measured on
  // a child that traps TERM and exits 42 after a moment — exactly what
  // `./equin build` does via `installFatalSignalExit`: without this the
  // marker read `143 TERM` with the child still alive; with it, `42 TERM` and
  // the child already gone.
  //
  // `kill -0` is what makes the retry safe. A second `wait` on an ALREADY-REAPED
  // pid returns 127 and prints `wait: pid N is not a child of this shell` into
  // the transcript, which would corrupt the status of any run whose signal and
  // exit landed in the same instant. `kill -0` still succeeds on a zombie (dead,
  // not yet reaped) and fails once our own `wait` has reaped it — and a pid
  // cannot be recycled before it is reaped, so this cannot false-positive.
  'while [ "$i" = 1 ] && kill -0 "$c" 2>/dev/null; do',
  "i=0;",
  'wait "$c";',
  "s=$?;",
  "done;",
  '[ -n "$g" ] || g=-;',
  `printf '%s %s\\n' "$s" "$g" > "$${RUN_TERMINAL_ENV}.tmp.$$"`,
  `&& mv "$${RUN_TERMINAL_ENV}.tmp.$$" "$${RUN_TERMINAL_ENV}";`,
  'exit "$s"',
].join(" ");

/**
 * Wrap a command in the exit-recording shim.
 *
 * Returns the argv to spawn and the environment entries the shim needs, as two
 * fields of ONE result — a caller cannot take the argv and forget the env,
 * which would spawn a shim that writes its marker to `.tmp.<pid>` at the
 * filesystem root and then reports every run as hard-killed.
 *
 * ## Why the trap is the ONLY source of `signalCode`
 *
 * A killed child and a child that chose `exit(143)` are **the same number**.
 * POSIX `wait` reports a signalled child as `128 + signo`, so `$?` alone cannot
 * separate `kill -TERM` from a program that deliberately exits 143 — which is
 * exactly the ambiguity `verb-outcome.ts` was written to remove after
 * `drun-1787890652933-wr3v6d` was recorded as `Exited with code 143`, a
 * sentence about a command that never exited and never refused.
 *
 * So the shim records only what it **observed**: its trap fired, therefore a
 * signal arrived. It deliberately does NOT decode `kill -l $((s-128))` when the
 * trap did not fire. That decode looks like a free second source and is in fact
 * the original guess moved one layer down: it turns a genuine `exit 143` into
 * `signalCode: "TERM"`, manufacturing the exact false claim this field exists
 * to prevent. Verified against `/bin/sh`: with trap-only, `exit 143` yields
 * `143 -` and a group SIGTERM yields `143 TERM`.
 *
 * The cost is one honest blind spot: a child signalled **individually**, with
 * `sh` left untouched, records `signalCode: null` because this process never
 * saw a signal. Nothing in this system produces that, and the reason is worth
 * citing rather than asserting, because the whole argument rests on it — both
 * kills that reach a supervised run go to the whole process GROUP:
 *
 * - `killSupervisedRun` signals `-pid` (see its docblock for why signalling the
 *   shim alone would orphan the real work);
 * - the gateway hot-restarts a backend through `signalBackend`
 *   (`gateway/worktree.go:584`) → `killGroup` → `killPgid`, which bottoms out
 *   in `syscall.Kill(-pgid, sig)` — the path that killed a running deploy 0.9 s
 *   after spawn on 2026-08-28.
 *
 * The shim is inside that group either way, so it is always hit. `null`
 * therefore reads as "not observed as killed", never as "definitely exited
 * normally" — the weaker claim the evidence actually supports.
 *
 * Signal names are the bare POSIX spelling with no `SIG` prefix — `TERM`,
 * `INT`, `HUP` — because that is what the trap clause itself names.
 *
 * ## SIGINT does not cancel a supervised run — use SIGTERM
 *
 * POSIX requires a non-interactive shell to set SIGINT (and SIGQUIT) to
 * **ignore** for the commands of an asynchronous list, and an ignore
 * disposition is inherited across `exec`. So the supervised child ignores
 * SIGINT outright: measured, a child sent a group SIGINT ran to completion and
 * exited 0, and a child with its own INT trap never saw it fire.
 *
 * The shim traps INT anyway, and that is the useful behaviour rather than a
 * half-measure: the signal is *recorded* (`signalCode: "INT"`), the shim keeps
 * waiting, and the run closes with whatever the child really did — so a run
 * that shrugs off an INT reads as `exitCode: 0, signalCode: "INT"`, which is
 * exactly what happened. Without the trap the shim would die on the signal and
 * leave the child running orphaned with no marker, reported as a hard kill.
 *
 * `killSupervisedRun` therefore defaults to SIGTERM, which the child does
 * receive. Do not reach for INT expecting it to stop anything.
 *
 * `/bin/sh` by absolute path: this runs under whatever environment the backend
 * inherited, and resolving `sh` through `PATH` is one more thing that can be
 * wrong on a machine we do not control.
 */
export function supervisedArgv(
  argv: readonly string[],
  terminalPath: string,
): { argv: string[]; env: Record<string, string> } {
  if (argv.length === 0) {
    throw new Error(
      "[supervised-run] supervisedArgv: empty argv — there is no command to supervise.",
    );
  }
  return {
    argv: ["/bin/sh", "-c", SHIM_SCRIPT, SHIM_ARGV0, ...argv],
    env: { [RUN_TERMINAL_ENV]: terminalPath },
  };
}
