# runtime-identity

**Which namespace is THIS PROCESS — and, for a serving backend, which socket
does it answer on?** What the spawner hands a process at its entry point,
declared once there, read everywhere else, and a throw when nobody said.

```ts
import {
  declareRuntimeNamespace,
  runtimeNamespace,
  isMain,
  readServingSocket,
  servingSocketPath,
} from "@plugins/infra/plugins/runtime-identity/core";
```

## Two identities that look alike

| question | answer | who may ask |
|---|---|---|
| which namespace is this RUNTIME the server for? | `runtimeNamespace()` | a gateway-spawned backend, or an `exec` child its spawner told |
| which namespace does this CHECKOUT own? | `checkoutNamespace(root)` (`infra/paths`) | the CLI, checks, e2e scripts |

Only the SPAWNER can answer the first: a composition's backend runs out of
main's checkout, so nothing about a process's own filesystem says which app it
serves. A CLI process has no runtime namespace at all, and asking for one throws
rather than guessing — guessing picks a database, and picking the wrong one
silently is worse than refusing.

## How the value arrives

- **A backend** is spawned by the gateway as `… bin/index.ts --namespace <ns>`
  (`gateway/worktree.go`), and `server-core/bin/declare-namespace.ts` — the
  literal first import of `bin/index.ts` — declares it before anything else runs.
  It has to be first: `plugins-active.ts` selects the plugin registry at module
  eval and `config_v2` resolves its config dir at module eval, so an import above
  that line boots the process with no identity.
- **An exec child** gets it as a parameter: `runExec(namespace, body)`. Its own
  spawner passes `--namespace <ns>` on the argv (`supervised-exec` declares the
  option as REQUIRED).
- **A worker thread** shares no module state with the thread that made it, so it
  is spawned the same way a backend is: `new Worker(url, { argv: namespaceArgv() })`,
  and its entry's literal first import reads it with `readNamespaceArgv` and
  declares it (the sentinel worker, `sentinel/server/internal/worker/declare-namespace.ts`).
  Not over a message: a message arrives after the worker's whole import graph has
  run, and any module that resolves a path at eval has already thrown.

`namespaceArgv()` (spawner side) and `readNamespaceArgv(argv)` (entry side) are
the one spelling of the `--namespace` flag and its "given with no value" error.
- **`bun test`** declares the checkout it runs from, once, in
  `test/bun-preload.ts`.

## Why not an environment variable

It was one — `SINGULARITY_WORKTREE` — and an env var reaches every descendant
forever. Main's backend was the first process to talk to the tmux server after a
restart, so the tmux server kept main's environment, and from then on every agent
session started life believing it was main. Every `./singularity build`, `check`
and `test` those sessions ran inherited it and filed its records under
`singularity`. Nothing chose that value.

Module state cannot be inherited, which is the whole point of putting the answer
here. `namespace-identity/no-ambient-worktree-env` (rung 3) keeps the variable
from coming back: the name may not appear in code anywhere but the rule's own
source and test.

Design:
[`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`](../../../../research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md).

## The serving socket

A gateway-spawned backend is also handed the Unix socket it serves on, as
`--socket <path>`. Only the gateway knows it: a backend alternates between
`<ns>.sock` and `<ns>.next.sock` across hot restarts, so it cannot be derived
from the namespace.

- `readServingSocket()` is called once, by each serving entry point just before
  it binds (`server-core/bin/index.ts` `bindSocket`, `central-core/bin/index.ts`).
  It reads the flag and records the path.
- `servingSocketPath()` answers code that must reach its own backend over HTTP
  (the stats profiling endpoint). It throws in a process that serves nothing — a
  CLI, a test, an `exec` child — rather than handing it somebody else's socket.

It used to be the `SOCKET_PATH` environment variable, which reached every process
a backend started (the tmux server, toolbar builds, `supervised-exec` children).
There is no fallback to it any more, and `launcher:per-process-env-on-argv` bans
the name in code. Design:
[`research/2026-09-15-global-backend-env-leak-followups.md`](../../../../research/2026-09-15-global-backend-env-leak-followups.md).

## Redeclaring

`declareRuntimeNamespace` is idempotent for the same value and THROWS on a
different one. Two answers to "which app am I" means half the process reads one
database, config dir and log tree while the other half reads another, and both
halves look like they worked.

`resetRuntimeNamespaceForTest()` is the only way out, and it is named for what it
is. Two callers: the `bun test` preload, and the one suite that simulates several
worktrees in a single process (`log-channels`' `handle-emit.test.ts`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: What the spawner hands a PROCESS at its entry point, declared once there and read everywhere else: the namespace it runs as (`--namespace`, from the gateway or an exec child's spawner) and, for a serving backend, the Unix socket it serves on (`--socket`). Asking for one that was never declared throws.
- Core:
  - Uses:
    - `infra/namespace.asNamespace`
    - `infra/namespace.MAIN_WORKTREE_NAME`
    - `infra/namespace.Namespace`
  - Exports (values):
    - `declareRuntimeNamespace`
    - `hasRuntimeNamespace`
    - `isMain`
    - `namespaceArgv`
    - `readNamespaceArgv`
    - `readServingSocket`
    - `runtimeNamespace`
    - `servingSocketPath`
- Cross-plugin:
  - Imported by:
    - `infra/jobs/supervised-job`
    - `infra/paths`
    - `plugin-meta/barrel-import`
- Test helpers:
  - Core: `@plugins/infra/plugins/runtime-identity/core/testing`
    - `resetRuntimeNamespaceForTest` — Drop the declaration.

<!-- AUTOGENERATED:END -->
