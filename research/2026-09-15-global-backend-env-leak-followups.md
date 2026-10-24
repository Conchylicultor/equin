# Backend environment follow-ups: the socket moves to argv, `claude --print` gets an allowlist, the comment stripper learns Rust

Follow-up to `research/2026-09-15-global-declared-runtime-environment.md`.

## Context

The declared-environment change stopped the gateway from forwarding its
starter's environment to backends. Three loose ends remain.

1. **The socket path still travels in the environment.** `gateway/worktree.go`
   `startBackend` sets `SOCKET_PATH=<path>` on each backend. Every process the
   backend starts inherits it: the tmux server (when the backend is the first to
   talk to it), toolbar builds through `supervised-run`, `supervised-exec`
   children, the release/deploy CLIs. It is the last per-process value in the
   environment. The namespace already moved to argv (`--namespace`) for this
   reason.

   **Measured (Bun 1.3.13):** deleting or changing `process.env.X` does not
   change what a child receives. `Bun.spawn` and `child_process` with no
   explicit `env` pass the environment the process *started* with. So a backend
   cannot read `SOCKET_PATH` and then remove it. The only fix is that it never
   arrives in the environment.

   **Transition constraint.** The Go gateway is rebuilt only on a manual
   `./equin start`. The running gateway (PID 59982, started 14:10) is
   still the binary from *before* the declared-environment change. And
   worktrees that are not rebased run backend code that reads `SOCKET_PATH`
   from the environment only.

2. **`run-claude-print.ts` builds its child's environment with a denylist.** It
   copies `process.env` and drops `CLAUDE_CODE_*`. The scrub **still matters
   today**: because the gateway has not been restarted, main's backend still
   carries `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and a dozen other
   `CLAUDE_CODE_*` values (checked with `ps eww` on PID 85421). Deleting it now
   would bring back the bug it was written for. But a denylist is the weaker
   pattern: it catches only the names someone thought of.

3. **The comment stripper reads Rust as if it were Go.** In
   `launcher/check/internal/strip-comments.ts`, `stripCLike` handles both. For
   Rust it gets three things wrong: raw strings (`r#"…"#`), nested block
   comments, and ordinary strings that span lines (legal in Rust, not in Go).
   It also treats a backtick as a Go raw string, which Rust does not have. No
   file under `tauri/src-tauri/` uses any of these today, so nothing is misread
   now. This change prevents a future misread.

## Design

### 1. The socket path goes on argv, and the spec says when

**The transition signal is the spec file.** Every build writes `spec.json` for
its namespace from the *same checkout* whose backend the gateway will spawn
(`writeWorktreeSpec` in `plugins/infra/plugins/worktree/server/internal/spec.ts`,
called by the dev build, compositions, central, and the release launcher). So a
spec field can state what that checkout's backend accepts.

- **Writer.** `writeWorktreeSpec` always writes `"socketTransport": "argv"`. It
  is not a parameter, so no caller can leave it out.
- **Gateway** (`Spec` gains `SocketTransport string json:"socketTransport,omitempty"`).
  `startBackend` asks a new pure helper,
  `backendLaunch(spec, name, socketPath) (argv []string, extraEnv []string)`:
  - `"argv"`: append `--socket <path>` after `--namespace <name>`. The
    environment is the declared base alone (`ChildEnv.With()`), with no
    `SOCKET_PATH`.
  - absent: the legacy contract, as today. `SOCKET_PATH` in the environment, no
    `--socket`. The comment names it as the transition branch for specs written
    by older checkouts.
  - any other value: the spawn fails with an error naming the value.
- **Backend.** A new module in `plugins/infra/plugins/runtime-identity/core`
  (`internal/serving-socket.ts`). It is the same kind of thing as the namespace:
  a value the gateway hands a process at its entry point, declared once there
  and read everywhere else.
  - `readServingSocket()` is called once, by each serving entry:
    `server-core/bin/index.ts` `bindSocket`, and `central-core/bin/index.ts`. It
    reads `--socket <path>` from `process.argv`. A flag with no value throws. If
    the flag is absent it falls back to `SOCKET_PATH` from the environment and
    logs one warning: *the gateway or this spec predates `--socket`; rebuild,
    and restart the gateway with `./equin start`*. If neither is set, it
    throws. The fallback is the only place in TypeScript allowed to read
    `SOCKET_PATH`. It records the path.
  - `servingSocketPath()` returns the recorded path, and throws if nothing
    declared one. An `exec` child never declares one, so it cannot pick up a
    socket by accident.
  - `runtime-identity`'s description and CLAUDE.md widen from "the namespace" to
    "what the gateway hands a process at its entry point: its namespace and, for
    a serving backend, its socket".
- **Readers.** `handle-stats-profiling.ts` uses `servingSocketPath()`. Today it
  returns an empty result when `SOCKET_PATH` is missing, which hides the failure
  as "no data". `server-core/cli/run-exec.ts`'s comment says "`SOCKET_PATH` is
  not set in a child". That is false today (an exec child inherits the
  backend's environment), so the comment is corrected.

**Every combination works:**

| Gateway | spec.json | Backend code | Result |
|---|---|---|---|
| old (running now) | new | new | env → fallback + warning. Leak as today. |
| new | new | new | `--socket` only. **No leak.** |
| new | stale (not rebased) | stale | env, as today. Stale backend boots. |
| new | old (rebased, not yet rebuilt) | new | env → fallback. Boots. |

The last row covers a gateway that respawns a backend from live source after an
idle stop, without a build having rewritten `spec.json`. An old backend never
receives `--socket`: the gateway sends it only when the spec asks for it. The
backend's argv reading is a bare `indexOf`, so an extra flag would not break it
anyway.

The leak ends at the user's next gateway restart, for every namespace built
after this change. No stale worktree breaks.

**Enforcement (rung 3).** A new check, `launcher:per-process-env-on-argv`, in
`plugins/infra/plugins/launcher/check/index.ts`. It holds a table of per-process
values that travel on argv. Each entry maps the old variable name to its flag
and to its transition sites: the files still allowed to name it. For
`SOCKET_PATH` those are `gateway/worktree.go` (the legacy branch) and
`serving-socket.ts` (the fallback read). The check reuses the comment stripper,
and it scans the same file set as `launcher:runtime-env-declared`: TypeScript,
the gateway's Go, the git hooks and the Rust. Tests are exempt. The check also
reports a listed site that no longer names the variable, so the table is
removed together with the transition code.

(The plan first said to extend the namespace lint rule. A check covers the Go
side too, and ESLint does not.)

pgbouncer's local constant `SOCKET_PATH` in `scripts/start.ts` is renamed to
`PGBOUNCER_SOCKET`.

**Docs.** `gateway/CLAUDE.md` (the Backend Contract, the registry fields, the
"In Bun" line), `server-core/CLAUDE.md`, `central-core/CLAUDE.md`, and the
"SOCKET_PATH: the gateway sets it per backend" line in `runtime-env.ts`.

### 2. `claude --print` starts from host facts only

`launcher/core` gains `pickHostEnv(source)`: the subset of `source` named in the
existing `RUNTIME_HOST_ENV` list (`HOME USER LOGNAME SHELL PATH TMPDIR LANG
LC_ALL LC_CTYPE`), which is reused unchanged. It is not `pickRuntimeEnv`,
because that function also forwards the `SINGULARITY_*` installation settings
and OAuth-credential prefixes, which a third-party CLI has no use for.

`run-claude-print.ts` passes `env: pickHostEnv(process.env)` and drops the
`CLAUDE_CODE_*` loop. The comment explains why this is an allowlist: the
process's environment is an open set, and the agent pane already runs `claude`
under `env -i` with a similar list (`agent-session-env.ts`), which is evidence
that auth and the keychain need nothing more. This works whether or not the
gateway has been restarted, which is why it can land now.

`TMPDIR` does not conflict with the hard-coded `cwd: "/tmp"`. One sets where
temporary files go, the other the working directory.

### 3. Separate Go and Rust readers in the comment stripper

`stripCLike` becomes two functions, `stripGo` and `stripRust`, chosen by file
extension in `stripComments`. Each recognizes only its own language's literals.

- **Go:** unchanged behaviour. Line and non-nesting block comments,
  interpreted strings that stop at a newline, backtick raw strings, runes.
- **Rust:**
  - Block comments nest: keep a depth count, and count `/*` and `*/` inside
    a comment.
  - Ordinary and byte strings (`"…"`, `b"…"`) may span newlines.
  - Raw strings `r"…"`, `r#"…"#`, `br##"…"##`: the closing quote must be
    followed by the same number of `#`. They are recognized only at a token
    start (the previous character is not part of an identifier), so `r#type`
    (a raw identifier) and `bar"` are not raw strings.
  - Char literals versus lifetimes: the existing `CHAR_LITERAL_RE`, plus
    `b'x'`.
  - Backticks are ordinary characters.

The file comment's "Not handled" line is deleted. No real Rust file exercises
these cases, so synthetic fixtures in `strip-comments.test.ts` are the only
coverage. One fixture per case, each hiding a `SINGULARITY_`-style word on the
wrong side of the boundary:

- a `//` inside a raw string;
- `"#` inside `r##"…"##`;
- a nested `/* /* */ still comment */ CODE`;
- a multi-line string containing `//`;
- `r#type`;
- `b'"'`.

## Steps (each one builds and its checks pass)

1. **Comment stripper** (item 3) and its tests.
2. **`pickHostEnv`** and its test in `launcher/core`. `run-claude-print.ts`
   switches to it. The env-building function is extracted so a test can assert
   that `CLAUDE_CODE_EXTRA_BODY`, `CLAUDECODE`, `SOCKET_PATH` and
   `SINGULARITY_CONVERSATION_ID` are dropped, and `HOME` and `PATH` are kept.
3. **Backend side of the socket.** Add `serving-socket.ts` with tests (argv
   read, flag without a value, environment fallback, neither set, and
   `servingSocketPath()` before anything is declared). Convert the two entry
   points and the stats handler. Under the running old gateway this takes the
   fallback path, so it is safe to ship alone.
4. **Spec field and gateway.** Add the writer field, the Go `Spec` field and
   `backendLaunch`. Table tests in `gateway/worktree_test.go` cover `"argv"`,
   absent and unknown, and assert that `--socket` and `SOCKET_PATH` never both
   appear. Update the docs.
5. **The `launcher:per-process-env-on-argv` check.**
6. **`./equin build`** (in the background).
7. **Gateway restart and verification.** Only the user runs this step, or
   asks the agent to run it.

## Verification

- `go test ./...` in `gateway/`, and
  `./equin test plugins/infra/plugins/launcher plugins/infra/plugins/runtime-identity plugins/infra/plugins/claude-cli`.
  Then `./equin check` passes.
- **Negative probes:**
  - add a throwaway `process.env.SOCKET_PATH` read in some plugin and confirm
    `launcher:per-process-env-on-argv` names it;
  - add a throwaway `r#"// SINGULARITY_PROBE"#` to `lib.rs` and confirm
    `launcher:runtime-env-declared` reports `SINGULARITY_PROBE`.

  Revert both.
- **After the build, under the still-running old gateway:**
  - this worktree's `spec.json` has `"socketTransport": "argv"`;
  - its backend log shows the one fallback warning;
  - the app answers at `http://<wt>.localhost:9000`;
  - Debug → Stats profiling returns spans.
- **`claude --print`:** trigger a task title generation (a new task with a vague
  title). With `query_db`, check that the newest `claude_cli_calls` row has
  output and no error.
- **After the user restarts the gateway:**
  - `ps eww -o command= -p <main backend, this worktree's backend>`: argv
    contains `--socket …`, and the environment has no `SOCKET_PATH`.
  - A worktree that is not rebased still boots, with `SOCKET_PATH` in its
    environment and no `--socket`.
  - A toolbar build started from main has no `SOCKET_PATH` in its child's
    environment.
  - A backup run (a `supervised-exec` child) completes.

## Follow-up (its own task)

Once the gateway has been restarted and namespaces built before this change are
gone:

- delete the gateway's legacy branch, the backend's environment fallback, and
  the `socketTransport` field, together;
- change `SOCKET_PATH`'s entry in `launcher:per-process-env-on-argv` to list no
  transition sites, which bans the name everywhere.

A worktree built before this change will then need a rebase and a build.
