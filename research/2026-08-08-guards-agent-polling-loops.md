# Guards against agent polling loops

## Context

Agents burn turns watching long operations finish instead of letting the harness
wake them. The trigger was `conv-1786116592-b70n`, where an agent ran
`./equin push` in the foreground, the tool timed out, and it then re-read
the leftover output file every ~4 seconds for 35 calls.

This is not one bad session. Replaying every transcript under
`~/.claude/projects` from the last 30 days:

- **47 sessions** contain a run of ≥6 consecutive tool calls observing the same
  thing, **528 tool calls** in those runs alone.
- The existing `repeated-command` guard caught **2 of 47**. It keys on
  byte-identical consecutive commands; in 40 of the 45 misses the longest
  identical-in-a-row streak was **1**, because the agent varies `tail -25` →
  `-30` → `-35` or appends an `echo` every time. This is incidental drift, not
  deliberate evasion — byte-equality is simply the wrong identity.

Why agents do it, from the same corpus:

- The wake-up already exists. Every background launch is answered with
  *"You will be notified when it completes."* — **4,034** occurrences. Agents
  poll anyway: in the linked session the agent used `run_in_background: true`
  for its builds and then launched
  `until ! grep -q '"status": *"running"' …/build-status.json; do sleep …; done`
  as a *second* background task. It was told it would be notified and hand-rolled
  a timer regardless. **For most polling, no mechanism is missing — the existing
  one is distrusted.**
- One case has genuinely no wake-up, and it produced the linked loop: a
  **foreground** command that outlives its timeout. The whole result is
  `Command timed out after 10m 0s` — no task id, no notification — while the
  process keeps running. **510** such timeouts in the corpus. Ops are long enough
  to hit this routinely: from `~/.singularity/op-log.jsonl` (14 days), build p50
  **9.8 min** / p90 36.8 min, push p50 **9.1 min** / p90 35.7 min, against a
  600 s foreground maximum.
- Background tasks have **no timeout** — measured lifetimes of 125, 386 and 823
  minutes (101 of 109 measurable tasks outlived 10 minutes).

So forcing every long op into the background removes the only case that lacks a
wake-up, and a detector removes the waste in the rest. No new runtime surface is
needed.

## Intended outcome

An agent that starts a build, push or check gets re-invoked when it finishes, and
cannot spend turns watching it. Three changes, all inside the guards plugin plus
its shell parser.

---

## 1. `parseShell` — see inside loop bodies and substitutions

`plugins/framework/plugins/tooling/plugins/guards/core/parse-shell.ts`

Today `parseShell` is a flat splitter on `&& || ; | & \n`. It has no concept of
block structure, so:

```ts
parseShell("until false; do git push; done").calls
// [ {name:"until", args:["false"]},
//   {name:"do",    args:["git","push"]},   <-- git push hides here
//   {name:"done",  args:[]} ]
```

`gitPushGuard`'s predicate is `c.name === "git" && c.args[0] === "push"`, so it
never fires. The same hole exists for `$(…)`, backticks and `( … )` subshells,
and it silently defeats **`git-push`, `git-reset-main`, `migrations`, `postgres`
and `main-writes`**.

This is a prerequisite here, not a drive-by: change 2 below must see
`./equin build` inside `until …; do ./equin build; done`, which is
exactly the shape agents already write.

**Change:** after splitting, flatten each segment before emitting a `ShellCall`.

- Strip leading block keywords (`until while for if then elif else do done fi !`)
  and re-split the remainder, so a loop body yields its own calls.
- Recurse into `$( … )`, `` ` … ` `` and `( … )`, appending the inner calls.
- Preserve `.raw`, `.cwd` and the existing `cd`-folding semantics; inner calls
  inherit the enclosing call's `cwd`.

Keep `findCall`'s contract unchanged — callers gain coverage with no edits.

**Tests** (`core/parse-shell.test.ts`, new, `bun:test`): the five affected guards
each get a loop-body and a `$(…)` case asserting they now deny — e.g.
`until false; do git push; done`, `echo $(git reset --hard origin/main)`.

---

## 2. `background-ops` guard — long ops may only run in the background

New: `core/guards/background-ops.ts`, registered in `core/registry.ts`.

**Rule.** Deny a Bash call that invokes `./equin <build|push|check|test|release>`
unless the tool input carries `run_in_background: true`.

Also deny the shell-level fakes — trailing `&`, `nohup`, `setsid`, `disown` —
because only the *tool-level* flag produces a tracked task and its completion
notification. A shell-detached op is exactly the handle-less state we are
removing.

Allow: fast read-only subcommands that never take the host lock
(`check --list`, `--help`, `-h`, `--version`).

`BashInput` in `core/types.ts` gains `run_in_background?: boolean` (the
PreToolUse payload already carries the full `tool_input`).

**Deny message** names the fix and the reason:

> `./equin build` takes ~10 min at the median and can exceed the 600 s
> foreground maximum. Re-run it with `run_in_background: true` and end your turn
> — you will be re-invoked when it finishes. A foreground timeout leaves the
> build running with no handle and no notification.

Use `defineGuard` with `bypassToken: ".allow-foreground-ops"` for the rare
interactive case.

---

## 3. `poll-loop` guard — key on *what is watched*, not on the bytes

New: `core/guards/poll-loop.ts`, replacing `core/guards/repeated-command.ts`.

### Classification

Each Bash command is one of three things:

- **mutate** — invokes a builder/package manager, a writing `git` subcommand, a
  destructive coreutil (`rm mv cp mkdir touch chmod ln tee`), or redirects to a
  real file (`> path`, not `> /dev/null`). **Resets the window** — real progress
  happened.
- **observe** — every simple command is read-only (`cat head tail grep rg jq wc
  ls stat pgrep ps sleep sed awk cut sort uniq`, `kill -0`, read-only `git`
  subcommands, `curl`) **and** it references ≥1 watch subject.
- **neutral** — anything else. **Ignored** — neither counted nor resetting.

The neutral arm is load-bearing. An earlier prototype treated unclassifiable
commands as progress and reset the window, which is why it missed the largest
loop in the corpus (163 `pgrep` calls interleaved with `uptime` and productive
`Read`s).

### Watch subjects

Extracted by pattern from the raw command; a command's fingerprint is its **set**
of subjects:

| subject | from |
|---|---|
| `task:<id>` | `…/tasks/<id>.output`; also every `BashOutput`/`TaskOutput` call |
| `receipt:build:<wt>` | `build-status.json` |
| `log:build` | `build-*.log`, `build-progress.jsonl` |
| `log:<channel>` | `logs/<channel>.jsonl` |
| `proc:<pattern>` | `pgrep -f <pat>`, `ps aux`/`-ef` |
| `pid:<n>` | `kill -0 <n>`, `ps -p <n>` |
| `git:remote` | `git ls-remote`, `git branch -r --contains`, `git rev-parse origin/…` |
| `url:<host+path>` | `curl http://…` |

Digits are normalised out, so `tail -25` and `tail -40` collapse. Two commands
are the same watch when their subject sets **intersect** — not when they are
equal. That is what defeats the `cat X` → `cat X; pgrep Y` drift that beat the
old guard.

### Window

Keep the last **20** observational calls in the session state file. Trip when the
incoming call shares a subject with **3** of them (4 including itself) inside a
**30-minute** span. Any mutating command clears the window.

### Liveness decides deny vs inform

At trip time the guard resolves whether the watched thing is still live —
`resolveBuildReceipt` for a build receipt, `pidAlive` for a pid, a `pgrep` for a
process pattern (both already exported from
`plugins/framework/plugins/cli/bin/build-receipt.ts`).

- **Live** → `deny`, with a message matched to the subject:
  - `task:<id>` → *"That background task will re-invoke you when it exits. You do
    not need to check it. End your turn."*
  - build receipt running → *"The build is running (started 6m ago, pid 1234).
    End your turn; you will be notified."*
  - a process not owned by this session → *"Nothing here will wake you. Stop and
    tell the user what you are waiting for."*
- **Terminal** → `allow`, but attach the verdict as non-blocking
  `additionalContext` (*"that build finished: BUILD OK — deployed …"*). Repeatedly
  grepping a finished build's log is forensics, not waiting, and must not be
  blocked.

### Verdict escalation

First trip on a subject is `deny` — it blocks the call while leaving the turn
intact, so the agent can end cleanly. Escalate to `fatal` (`continue: false`) only
on a second trip for the same subject. Today's guard goes straight to `fatal`,
which kills the turn and discards context on first contact.

### State

Same tmpdir file, but keyed off the PreToolUse payload's `session_id`.
`core/runner.ts`'s `HookInput` currently declares only `{tool_name, tool_input,
cwd}` and the old guard reads the undocumented `process.env.CLAUDE_CODE_SESSION_ID`
instead. Add `session_id` to `HookInput`, thread it through `GuardContext`
(`core/context.ts`), and drop the env-var dependency.

`repeated-command.ts` is deleted. Replaying it over the same 30 days it would
have fired 6 times, and `poll-loop` now covers **all 6** — but only after adding
`time:sleep`, because a command that merely sleeps names no file and no process
and so had no subject at all (`sleep 300; echo TICK`, repeated 9 times in one
session, was invisible).

One case is deliberately left uncovered: the same **mutating** command repeated
identically. `poll-loop` treats a mutation as progress and clears the window, so
it will never fire there. That is the right call — re-running `./equin
build` after each fix is legitimate work and looks identical every time, so the
old guard's "any command, 5 in a row" scope was a false positive waiting to
happen.

---

## Measured result

Replayed over 455 transcripts from the last 30 days
(`e2e/replay-transcripts.ts`, as built):

- trips in **109 sessions**
- prevents **1,827** polling tool calls
- the 15 lowest-yield trips were hand-audited: all genuine waits
  (`until ! pgrep -f "[s]ingularity build"; do sleep 10; done`,
  `ps -p 94000 -o pid,stat,etime,wchan`) — no false positives

The loose prototype scored 133 / 2,288. The shipped rule is deliberately lower:
its mutation set is wider and more accurate, so a session where the agent runs
`bun test` between looks correctly resets the window instead of tripping. Those
are agents working, not waiting.

## Built beyond the plan

Two things the implementation forced that the plan did not anticipate:

- **Wrappers hide commands the same way loop bodies do.** `nohup ./equin
  build` parses to a call named `nohup`, so `background-ops` never saw it — and
  the same hole meant `nohup git push` walked straight past `git-push` today.
  `parseShell` now peels `nohup`/`env`/`sudo`/`timeout`/`nice`/`xargs`/… one
  layer at a time and emits the wrapped command as its own call.
- **A guard needed a third verdict.** "That build already finished: ok" is an
  answer, not an objection — denying it would be a false positive and staying
  silent leaves the agent guessing. `Verdict` gained an `inform` arm that returns
  `additionalContext` and lets the call through; the runner collects informs from
  every guard rather than returning on the first.

Two bugs the tests caught, both worth keeping in mind if this is touched again:
`2>&1` reports its redirection target as `&1`, which read as a file write and
classified every `pgrep … >/dev/null 2>&1` waiter as *progress*; and a quoted
`pgrep -f "singularity push"` splits at the space under a raw-text regex, so
process subjects are read off the parsed call instead.

## Files

| file | change |
|---|---|
| `…/guards/core/parse-shell.ts` | flatten loop bodies, recurse into `$( )` / backticks / subshells, peel wrappers and `VAR=` prefixes, keep `2>&1` from minting a call |
| `…/guards/core/parse-shell.test.ts` | **new** — loop / substitution / wrapper cases, incl. the five affected guards |
| `…/guards/core/poll-detect.ts` | **new** — the detection rule as pure functions (`classify`, `watchSubjects`, `detectPoll`) |
| `…/guards/core/poll-detect.test.ts` | **new** |
| `…/guards/core/guards/background-ops.ts` + `.test.ts` | **new** |
| `…/guards/core/guards/poll-loop.ts` + `.test.ts` | **new** — state, liveness and message arms |
| `…/guards/e2e/replay-transcripts.ts` | **new** — the corpus replay; `--assert` for the floor |
| `…/guards/core/guards/repeated-command.ts` | **deleted** |
| `…/guards/core/registry.ts` | register the two new guards, drop the old one |
| `…/guards/core/types.ts` | `BashInput.run_in_background`; `GuardContext.sessionId`; the `inform` verdict |
| `…/guards/core/runner.ts` | read `session_id` from the payload; collect informs |
| `…/guards/core/context.ts` | carry `sessionId`; `ctx.inform()` |
| `…/guards/core/define-guard.ts` | `Denial.fatal` for escalation; allow a check to return an `Inform` |
| `CLAUDE.md` | build step states `run_in_background: true` and that there is nothing to watch |

Reuse rather than re-implement: `defineGuard` (structured `blocked`/`why`/`hint`
+ bypass tokens), `findCall`, and `resolveBuildReceipt`/`pidAlive` from
`plugins/framework/plugins/cli/bin/build-receipt.ts`.

## Explicitly not doing

**No new CLI command.** An earlier draft proposed `./equin wait` plus a
push receipt. With change 2 in place every long op is a tracked background task
that notifies on exit, so there is never an op without a handle — `wait` would
have no caller.

## Verification

1. **Unit** (`bun:test`, alongside each guard, per the existing
   `rg-replace.test.ts` shape — `createContext()` is used real, not mocked):
   fingerprint equality across `tail -25`/`-40`, subject intersection for
   `cat X` vs `cat X; pgrep Y`, window reset on a mutating command, neutral
   commands neither counting nor resetting, terminal-receipt → allow.
2. **Corpus replay** — port the prototype at
   `scratchpad/proto2.ts` into `…/guards/e2e/replay-transcripts.ts`: run the real
   guard over every transcript's Bash calls in order and report trips and calls
   prevented. This is the acceptance gate — it makes the catch rate *measured*
   rather than asserted, and re-runnable when the rule is tuned. Target: ≥125
   sessions trip, ≥2,000 calls prevented, and the 12 lowest-yield trips stay
   genuine on audit.
3. **Live** — in this worktree run `./equin build` in the foreground and
   confirm `background-ops` denies with the right message; re-run with
   `run_in_background: true` and confirm it passes and the completion
   notification arrives. Then `cat` the task output file four times and confirm
   `poll-loop` denies on the fourth with the "you will be notified" arm.
4. `./equin check` (guards are plain TS under `type-check`), then
   `./equin build`.
