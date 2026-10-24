# Retire the SOCKET_PATH transition

## Context

A backend learns the Unix socket it serves on from `--socket <path>` on argv.
While the change rolls out, a namespace whose `spec.json` has no
`"socketTransport": "argv"` still gets the path as `SOCKET_PATH` in its
environment, and every process that backend starts inherits it. Background:
`research/2026-09-15-global-backend-env-leak-followups.md`.

The transition code lives in four places:

1. the gateway's legacy branch in `backendLaunch`, plus the `Spec.SocketTransport`
   field and its validation (`gateway/worktree.go`, `gateway/registry.go`);
2. the field that `writeWorktreeSpec` writes (`plugins/infra/plugins/worktree/server/internal/spec.ts`);
3. the environment fallback and its warning in `readServingSocket`
   (`plugins/infra/plugins/runtime-identity/core/internal/serving-socket.ts`);
4. the `SOCKET_PATH` transition sites in `launcher:per-process-env-on-argv`
   (`plugins/infra/plugins/launcher/check/index.ts`).

## What the machine looks like today (2026-09-16, read-only survey)

- **Live backends.** Only `singularity` and `central` are running. Both were
  started with `--socket`, so no running backend is reading `SOCKET_PATH`.
- **Specs.** 93 `spec.json` files under `~/.singularity/worktrees/`. Only 2 have
  the field: `singularity` and `att-1789492276-pml9`.
  - 38 of the other 91 point at a checkout that no longer exists.
  - 52 point at a checkout that still exists but isn't running. These are
    un-rebased worktrees.
  - `central`'s spec does not have the field. Every build rewrites central's
    spec (`build/cli/run.ts:1058` and `:1544`), including builds from
    un-rebased worktrees whose `writeWorktreeSpec` predates the field. So
    central's spec keeps losing the field. Right now central only has
    `--socket` because it happened to start while its spec still had it.
- **Gateway binary.** The running gateway (started 03:57) still contains the
  legacy branch, and only `./equin start` replaces it.

## Decision: one change, then restart the gateway

All four pieces come out in one push, and you run `./equin start` right
after the merge.

**The expected outage.** Main rebuilds on push, and that rebuild restarts main's
backend under the gateway that is still running. That old gateway sees a spec
without `socketTransport`, so it passes `SOCKET_PATH` instead of `--socket`.
Main's new backend has no fallback, so it throws at boot. Central does the same
the next time it restarts. Both come back once `./equin start` puts the
new gateway in place. (You chose this over a two-stage rollout.)

**After the restart:** every backend gets `--socket`. An un-rebased namespace
that wakes up fails loudly, because its old code only reads `SOCKET_PATH`.
Fixing it takes a **rebase and then** a rebuild. A rebuild alone still runs the
old backend code.

## Changes

Gateway (Go):

- `gateway/worktree.go`:
  - `backendLaunch(name, socketPath) []string` always returns
    `--namespace <name> --socket <path>`. No spec argument, no env result, no
    error.
  - `startBackend` sets `cmd.Env = w.cfg.ChildEnv.With()` and drops the "legacy
    socket variable" comment.
  - Delete `Spec.SocketTransport` and its doc comment.
- `gateway/registry.go`: delete the `socketTransport` validation. A spec on disk
  that still has the key loads fine, because `json.Unmarshal` ignores unknown
  keys.
- `gateway/launch_test.go`: replace the transport tests with two:
  - `backendLaunch` returns exactly the namespace and socket flags;
  - `loadSpec` accepts a spec with a leftover `"socketTransport": "argv"`.

Spec writer:

- `spec.ts`: drop `socketTransport` from the spec object and its type, and drop
  the paragraph explaining it.

Backend reader:

- `serving-socket.ts`: delete `LEGACY_ENV`, the `env` parameter, the fallback,
  its warning, and the TRANSITION header paragraph. The call becomes
  `readServingSocket(argv = process.argv)`, which throws without `--socket`. The
  two callers (`server-core/bin/index.ts`, `central-core/bin/index.ts`) pass no
  `env`.
- `serving-socket.test.ts`: delete the "argv wins over env" and "falls back"
  tests. Add a test that a `SOCKET_PATH` in `process.env` with no `--socket`
  still throws.

Check:

- `launcher/check/index.ts`: set `SOCKET_PATH.transitionSites` to `[]`. The
  entry stays, so the name is banned in all scanned code. Rewrite the section
  comment, which currently describes the transition as live.

Docs and comments:

- `gateway/CLAUDE.md`: remove the spec example key and its paragraph, update
  Backend Contract item 1, and remove "plus `SOCKET_PATH` for a legacy spec"
  from item 2.
- `runtime-identity/CLAUDE.md`: remove the Transition paragraph and keep one
  sentence of history.
- `launcher/CLAUDE.md`: the per-process paragraph now says the old name may not
  appear in code.
- `server-core/CLAUDE.md` item 1: remove the parenthetical.
- `launcher/core/internal/runtime-env.ts`: remove "the gateway still sets it"
  from the `SOCKET_PATH` bullet.

Test-only mentions (`env_test.go`, `runtime-env.test.ts`,
`agent-session-env.test.ts`) stay. They check that the variable is absent, and
tests are exempt from the check.

## Verification

- `cd gateway && go test ./...`
- `./equin test plugins/infra/plugins/runtime-identity`
- `./equin check launcher:per-process-env-on-argv type-check`
- `./equin build`, then confirm `status: ok` in
  `~/.singularity/worktrees/<wt>/build-status.json`.

A worktree build runs under the old gateway, so its backend fails to boot there
too. That is expected and confirms the new behavior. Check that the gateway log
shows the backend throwing "spawned without --socket", then treat the build as
verified only by the tests and checks above.

- Confirm the rebuilt spec has no `socketTransport` key.
- Confirm that
  `rg -n SOCKET_PATH --glob '!**/*test*' --glob '!research/**' --glob '!docs/**'`
  finds only the check's own table and prose.
- After push and `./equin start`: `ps` shows `--socket` on the
  `singularity` and `central` backends, and both are serving.
