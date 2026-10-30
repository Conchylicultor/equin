# drizzle-kit prompts over a PTY

## Context

`./equin build --migration-name <slug>` can no longer generate a migration whose diff makes
drizzle-kit ask create-vs-rename (drop + add in one table), even with `--migration-answers`.
`runDrizzleKitWithPrompts` (`plugins/framework/plugins/cli/plugins/migrations/cli/migrations-interactive.ts`)
spawns drizzle-kit with `stdin/stdout/stderr: "pipe"` and answers each prompt with keystrokes.
The upgrade drizzle-kit 0.28.1 → 0.31.11 (`6052246812`) added a guard to hanji's `render()`
(`bin.cjs:1450`):

```js
if (!process.stdin.isTTY || !process.stdout.isTTY)
  return Promise.reject(new Error("Interactive prompts require a TTY terminal …"));
```

So every prompt fails. The build's `\berror\b` check catches the message, and the build stops
with "printed a diagnostic but exited 0". That upgrade reported "no new migration,
migrations-in-sync ok" because nothing in the gate runs drizzle-kit through a prompt.

This blocks att-1793320131-wachkc (`tasks.mandate` jsonb → `tasks.mandate_ref` text).

## Approach: give drizzle-kit a real terminal

Bun 1.4.4 (the pinned runtime) supports `Bun.spawn(cmd, { terminal: { cols, rows, data } })`,
which allocates a PTY. I verified this in this worktree: inside it `[ -t 0 ]` and `[ -t 2 ]` are
true, `proc.stdout`/`proc.stderr` are `null`, all output arrives through `data` with CRLF line
endings, and keystrokes go in through `proc.terminal.write`. drizzle-kit then passes its guard and
hanji puts the PTY in raw mode, so our `ESC [ B` and `\r` bytes reach it unchanged. This is
the same way drizzle-kit is driven when a person runs it by hand. It doesn't patch drizzle-kit
or fake `isTTY`, and it doesn't pin us below 0.31.

### Changes in `migrations-interactive.ts`

1. **Spawn under a PTY**: `terminal: { cols: 1000, rows: 50, data }`. The wide terminal stops long
   option labels from wrapping, so hanji's redraw stays on one line per option and
   `OPTION_*_RE` still matches. Remove `stdin/stdout: "pipe"`. Write keystrokes with
   `proc.terminal!.write(...)` instead of `stdin.write`. Call `proc.terminal.close()` after
   `proc.exited`. Keep `NO_COLOR=1` (`stripAnsi` already handles cursor and erase CSI).
2. **Keep stderr a separate stream.** `migrations.ts:481` runs its `\b(error|collision|conflict)\b`
   heuristic on **stderr only**. If stdout were merged in, a prompt naming a column `error` or a
   table `conflicts` would wrongly fail the build. The PTY owns all three fds, so the argv is
   wrapped: `["/bin/sh", "-c", 'exec "$@" 2>"$0"', errFile, ...cmd]`. `exec` keeps the pid, so
   `resourceUsage().maxRSS` stays drizzle-kit's own. `errFile` is a fresh `mkdtemp` file. It is read
   into `stderrBuf` after exit and removed in a `finally`. With `echo`, stderr is printed to the
   parent's stderr after exit instead of live (it holds diagnostics only, so nothing is lost).
3. **Line handling**: decode `data` chunks with a streaming `TextDecoder` into the existing
   `stdoutBuf`/`strippedBuf`/`processBuffer()` path, which replaces the `proc.stdout` reader loop.
   Normalise `\r\n` → `\n` and drop lone `\r` in the stripped buffer, so the parsers see the same
   lines they did before. The final flush after exit stays as it is.
4. Update the file header comment and the `exempt/index.ts` reason: "parsed from a live PTY while
   keystrokes are written back". The rule still applies (it is still a raw `Bun.spawn`). Update
   the plugin `CLAUDE.md` where it describes piped stdio.

The `DrizzlePromptResult` shape and every caller (`migrations.ts`, detect / answer / keyed-regen
modes) stay unchanged.

### Prevent the next silent break: a real-drizzle-kit test

Add `cli/migrations-interactive.test.ts` (bun:test, pure logic beside source). It runs the
**real** installed drizzle-kit through `runDrizzleKitWithPrompts` + `drizzleGenerateArgv`
(`plugins/database/plugins/migrations/core`) on a throwaway tmp project: a `drizzle.config.ts`
plus a one-table schema file.

- Generate v1 (no prompts). Then change the schema to drop `a`, add `b`.
- Detect mode (`answers: null`): exactly one `column` prompt is detected with a `rename` option from `a`.
- Answer `{action:"rename", from:"a"}`: exit 0, and the generated SQL contains `RENAME COLUMN "a" TO "b"`.
- Answer `{action:"create"}`: the SQL drops `a` and adds `b`.
- Every case: `stderrBuf` doesn't contain "Interactive prompts require a TTY".

The deps updater's gates run `./equin test` (`plugins/infra/plugins/deps/plugins/updates/cli/internal/gates.ts`),
so a future drizzle-kit bump that breaks prompt driving fails its own upgrade task instead of
reaching a feature branch. That is the "check/test error" rung, instead of documenting the trap.
If drizzle-kit's `--config` cannot point at a tmp dir, mirror `stageDrizzleOut`'s staging
(`migrations.ts`). That is decided during implementation.

## Verification

1. `./equin test plugins/framework/plugins/cli/plugins/migrations`: the new test passes (and
   fails against the current piped implementation, which I'll confirm before switching).
2. `./equin check`: type-check, eslint (spawn-safety exemption still scoped to the one file).
3. End-to-end in this worktree, without committing a migration: temporarily rename a column in
   a scratch schema, run `./equin build --migration-name probe` (detect → exit 2 with the prompt JSON),
   then `--migration-answers '[{"action":"rename","from":"…"}]'`. Revert and drop the probe
   (`--reset-migration`). Or report to att-1793320131-wachkc that it can rebase and retry.
4. `./equin build` normally (no schema change) still passes.
