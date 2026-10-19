# guards

Claude Code hook guards. **PreToolUse** (`bin/guard.ts`): each guard inspects a
tool call before it runs and either allows it, denies it with an explanation,
rewrites it, or lets it through with a fact the model was missing.
**SubagentStop / TeammateIdle** (`bin/stop-guard.ts`): refuse to let an agent end
its turn while an op it started is still running.

## The stop guard, and why a subagent needs one

A subagent's background-task completion notification is filed under the PARENT
session's queue and never delivered, so an agent that backgrounds a build and
ends its turn is never woken — and whoever waits on it waits forever (measured:
nine hours). `background-ops` therefore tells a subagent to hold its turn open on
`./singularity await <op>` instead, and records which agent started which op
(`core/agent-ops.ts`), because neither half of "is this agent walking away from
its own op?" is available at stop time: the marker on disk doesn't say who asked,
and the stop payload doesn't say what they started.

`ctx.agent` is how a guard knows: `agent_id` is present on a subagent's payload
and absent on the main conversation's. Note `session_id` and `transcript_path`
are the PARENT's on a subagent's call — the same conflation that loses the
notification — so they cannot stand in for it.

The stop guard **fails open on every path that is not a confident block**, blocks
only on an op that agent started AND that is live right now, and respects
`stop_hook_active`. Claude Code also overrides any stop hook after 8 consecutive
blocks. Do not "tighten" any of these three: a stop hook that over-blocks is
worse than the bug it fixes.

## A guard never builds a path itself

`core/parse-shell.ts` turns a command string into `ShellCall`s. `core/argv.ts`
turns one call's argv into the operands that actually **name a file**, already
resolved against that call's working directory. Guards read the second one.

They used to do it themselves, with `call.args.filter((a) => !a.startsWith("-"))`
and a `resolve()` over whatever survived. That is a guess, not a parse: every
token that is not flag-shaped becomes a path. It denied a `sed -i '' 's|...|...|'`
on a worktree file because `path.resolve` normalised the `..` sequences inside
the substitution SCRIPT and landed them under the repo root — and it missed real
writes, because `cp -t <dir>` looks like a flag and `rm -- -weird` looks like one
too. Replaying 30 days of real sessions, that guessing plus a `2>&1` read as a
file named `&1` accounted for 56 of `main-writes`'s 60 denials.

A guard whose blocks are mostly noise is one agents learn to route around, which
is the failure that matters. `no-adhoc-path-resolve` (in the `guard-path-safety`
lint plugin) keeps it fixed: inside `core/guards/`, importing a value from
`node:path` is an error.

## Known gaps, on purpose

- **BSD `sed -i .bak`.** BSD spells the backup suffix as its own token. `-i` is
  modelled as taking no separate value — the only way both BSD's `sed -i ''` and
  GNU's `sed -i` parse the same — so a non-empty separate suffix fills the script
  slot and leaves the script in the operand list. That over-blocks; the file
  really being edited is still caught.
- **rsync value flags after the destination.** `rsync -a src/ dst/ --frobnicate x`
  — an unmodelled long flag placed last still steals the "last operand" slot. The
  table covers rsync's common ones; treating every operand as a target whenever
  an unknown flag appears would deny `cp --archive <main>/file .`, and copying
  *out of* main is legitimate and common.
- **`ln` over-blocks.** `ln -s <main>/a b` is denied even though `ln` only writes
  the link name. Narrowing it is a semantic change, not a parsing fix.

## A block is a claim about the world, so check it

`poll-loop` blocks on the grounds that *something else will wake you* — true
only while the watched thing is still running. So `Liveness` holds STATES only,
and every subject kind answers the question: a receipt is read, a pid gets
`kill -0`, a background task's completion notification is looked up in the
session transcript, a plain file is compared against the mtime each earlier look
recorded. Adding a subject kind means giving it an answer, not an arm exempting
it — an exempt category here is what let a finished task be told for an hour
that it would be "re-invoked when it exits".

A command that watches nothing (bare `sleep`, `echo` of fixed text) is still a
poll: it gets a `time:*` subject and the `nothing-watched` answer. Don't
exempt it as harmless — agents told not to `sleep` wait on `echo w1`, `echo w2`,
… instead, one session for six hours.

`readTranscript()` is a capability on the context, not the payload's
`transcript_path`, and `readTaskReport` returns `unreadable` distinctly from
`no-report`: "the harness has not said it finished" justifies a block, "I could
not look" does not.

## A guard can rewrite, too

Besides allow / deny / inform, a guard may return `{ rewrite: { … } }`: the
call goes through with those input fields replaced. Use it only when the fix is
mechanical and changes nothing the agent meant — otherwise deny and let the
agent retype. The runner merges the patch over the FULL tool input (Claude
Code's `updatedInput` replaces the input wholesale), emits it without a
`permissionDecision` so the normal permission flow still applies, and every
guard after a rewrite judges the rewritten input. Rewriters sit at the end of
the registry so the judging guards see what the agent typed.

`pipefail` is the one rewriter: `cmd | tail -20` exits with tail's status, so a
failing `cmd` read as a pass. It prefixes `set -o pipefail; ` when a pipe feeds
`tail` or `tee`, and backs off when any piped stage may stop reading early
(`head`, `grep -q/-m/-l`, a `sed` script with `q`, `awk … exit`): pipefail is
command-wide, and that reader's SIGPIPE would surface as a false exit 141. The
reader list errs toward backing off, since a miss only leaves the command as
typed. A reader it does not know, or a piped stage that never reads stdin
(`cmd | true`), can still produce a false 141.

## Measuring, not asserting

`e2e/replay-transcripts.ts` runs the guards over recorded transcripts and reports
what they would have done. Re-run `--guards` after touching `core/parse-shell.ts`
or `core/argv.ts` — both are inputs every Bash guard shares, so a change there
can blind or deafen all of them at once.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Claude Code PreToolUse guards: safety checks that intercept tool calls before execution
- Core:
  - Uses:
    - `infra/namespace.asNamespace`
    - `infra/namespace.isNamespace`
    - `infra/paths.HOME_DIR`
    - `infra/paths.worktreeArtifacts`
  - Exports (types):
    - `AllowVerdict`
    - `CommandClass`
    - `DenyVerdict`
    - `FileHint`
    - `FileOperand`
    - `Guard`
    - `GuardContext`
    - `InformVerdict`
    - `KnownCommand`
    - `ParsedArgv`
    - `PollDecision`
    - `RewriteVerdict`
    - `TaskReport`
    - `ToolMatcher`
    - `TranscriptRead`
    - `Verdict`
    - `WatchSubject`
    - `WindowEntry`
  - Exports (values):
    - `BYPASS_TOKENS`
    - `classify`
    - `createContext`
    - `defineGuard`
    - `detectPoll`
    - `GUARDS`
    - `MODULE_EXTENSION`
    - `parseArgv`
    - `parseShell`
    - `readTaskReport`
    - `redirectionTargets`
    - `THRESHOLD`
    - `TOOL_USE_ID_ENV`
    - `TOOL_USE_ID_RE`
    - `toolUseIdFrom`
    - `watchSubjects`
    - `WINDOW_MS`
    - `WINDOW_SIZE`
- Cross-plugin:
  - Imported by:
    - `debug/browser-recordings/writer`
    - `framework/tooling/e2e-harness`
- Exemptions:
  - Exempts itself from:
    - `guard-path-safety/no-adhoc-path-resolve` — `core/guards/git-diff-main.ts`, `core/guards/main-edits.ts`, `core/guards/poll-loop.ts` (sanctioned)
    - `python/no-system-python` — `core` (sanctioned)
    - `boundaries/no-platform-api` — `core/agent-ops.ts`, `core/argv.ts`, `core/context.ts`, `core/git-target.ts`, `core/guards/git-diff-main.ts`, `core/guards/main-edits.ts`, `core/guards/poll-loop.ts`, `core/parse-shell.ts`, `core/runner.ts`, `core/stop-guard.ts` (debt)

<!-- AUTOGENERATED:END -->
