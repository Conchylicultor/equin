# Gateway: fail loudly when a managed service does not start

## Context

A release bundle running on a remote host failed to boot. Two errors were emitted,
90 seconds and one file apart, sharing no vocabulary:

```
gateway.log (t=0):
  level=ERROR msg="supervisor: start failed; continuing without managed services"
    err="service \"postgres\": start command failed: exit status 1:
         initdb failed: initdb: error: cannot be run as root"

launcher stdout (t=90s):
  error: Postgres did not become reachable within 90000ms
  error: connect ENOENT /tmp/sgs-JsRda3/.s.PGSQL.5433
```

The first line names the cause exactly. The second is what the operator sees, and it
actively misdirects — an `ENOENT` on a socket path reads as a permissions/path bug,
not as "initdb refused to run." Diagnosis required knowing a gateway log existed,
finding it inside a temp-rooted data dir, and reading past the successful lines.

Two things are wrong, and they are independent:

1. **A precise diagnosis is produced at a process boundary and then discarded.**
   `gateway/main.go:158-160` logs the supervisor's start error and falls through.
   Nothing stores it, nothing propagates it, and the one process that is blocked on
   the thing that failed — the launcher, polling the PG socket — is never told.
   "Continuing" buys nothing: a gateway whose managed Postgres did not start can
   serve static files and nothing else. It converts a startup failure with a precise
   cause into a timeout with none. This is exactly what the repo's fail-loudly
   principle exists to prevent.

2. **A released bundle cannot run as root, and nothing says so or checks.**
   Postgres' `initdb` refuses to run as the root OS user. This is not an edge case:
   `plugins/apps/plugins/deploy/plugins/servers/server/internal/tables.ts:8` defaults
   `sshUser` to `"root"`, and the Hetzner console prose
   (`ssh-setup/plugins/hetzner/web/components/hetzner-console.tsx`) tells the user how
   to reach a *root shell*. The platform's default deploy path lands the operator in
   the one account the bundle cannot run under.

**Intended outcome:** the operator sees `initdb: error: cannot be run as root`, in
the terminal they are already looking at, within seconds — and on a fresh host they
never reach that failure at all, because the launcher refuses to start as root with
an actionable message.

### Root cause, in one sentence

The supervisor's `ServiceCrashed` state is an **absorbable failure** — a value with no
reason attached — and the gateway treats a startup precondition as optional.

## Design

Five changes, layered from the source of truth outward. Tasks 1–3 are the fix; 4 is
the prevention; 5 is docs.

### Task 1 — the supervisor's failure becomes state, not just a log line

`gateway/supervisor.go`.

- `Service` gains a `lastErr string` field, guarded by the existing `mu`.
- Add `setCrashed(err error)` alongside `setState`: sets `ServiceCrashed` **and**
  `lastErr` atomically. `setState(ServiceRunning)` clears `lastErr`. Replace the three
  existing `setState(ServiceCrashed)` call sites (`startService` ×2 at lines 194-197
  and 201-204, `runWatchdog` ×2 at lines 326-335) with it.
- `ServiceSnapshot` (line 116) gains `Error string \`json:"error,omitempty"\``;
  `List()` and `Get()` populate it.

`GET /gateway/services/postgres/status` then answers:

```json
{ "name": "postgres", "state": "crashed",
  "error": "start command failed: exit status 1: initdb failed: initdb: error: cannot be run as root" }
```

This is the repo's "failure must be a type, not an absorbable value" rule applied to
the gateway: `crashed` with no reason is a value a consumer cannot act on.

### Task 2 — a managed service that fails at startup is fatal

`gateway/main.go`.

- Replace the log-and-continue at lines 154-160 with: `slog.Error(...)`, **plus** a
  `fmt.Fprintf(os.Stderr, ...)` of the same error, then `os.Exit(1)`.
  The stderr write matters: `gateway-stdio.log` is truncated on every start
  (`boot.ts:370`, mode `"w"`), so it holds exactly this boot's fatal error with no
  scrollback to read past — it is the file the launcher can quote unambiguously.
- Apply the same treatment to the `NewSupervisor` load failure at lines 129-133. A
  malformed `database.json` is a misconfiguration, not an "I use an external DB"
  signal. A **missing** file stays benign — `NewSupervisor` already returns an empty
  supervisor on `ErrNotExist` (line 138), which is the real externally-managed-DB case.
- **Watchdog behaviour is unchanged.** A service that dies mid-session records
  `lastErr` (task 1) and the gateway stays up. Killing the gateway would tear down
  every live backend over a transient PG blip; startup and steady-state are different
  situations and get different policies.

`StartAll` already runs before `srv.ListenAndServe()` (line 193), so after this change
**"the gateway is listening" implies "every managed service came up"** — which is what
makes task 3 a one-line check instead of a protocol.

### Task 3 — the launcher waits on the gateway, not on a socket

`plugins/infra/plugins/launcher/server/internal/boot.ts`. This is the load-bearing
change: it generalises to *any* gateway startup failure, not just this one.

- New `readLogTail(path, lines)` helper (plain `readFileSync` + slice; ENOENT ⇒ null).
- New exported `awaitGatewayReady({ pid, port })`:
  - Polls `isGatewayListening(port)` — the existing helper at line 95 — through
    `retryUntil` + `exponential`, the same shape as the two existing waiters.
  - On **every tick**, checks `isRunning(pid)` (the existing helper at line 83). If the
    gateway process is gone, throw **immediately** with the tail of
    `gateway-stdio.log`, falling back to `gateway.log`, embedded in the message.
  - Deadline ~120s. With task 2 the gateway does not bind until `StartAll` finishes,
    and a cold `initdb` legitimately takes tens of seconds — but the pid-death check
    means the failure case never waits for the deadline.
- Call it in `bootSelfContainedApp` as a new step between `spawnGatewayDaemon` and
  `awaitPgReady` (boot.ts:525-534), and update the numbered ordering docstring at
  lines 486-501.
- Harden `awaitPgReady`'s `onDeadline` (line 433): before throwing, fetch
  `GET /gateway/services/postgres/status` and append the supervisor's recorded `error`
  (task 1) to the message. This covers the residual case — gateway alive, PG crashed
  after startup — which task 2 does not.
- **Also call `awaitGatewayReady` from
  `plugins/framework/plugins/cli/bin/commands/start.ts`**, which today prints
  `Gateway started (PID ${pid})` unconditionally at line 90 and returns. That is the
  same false-success in dev: `./equin start` reports success while the gateway
  is already dead.

Net effect on the incident: the launcher fails in ~2s with
`Gateway exited during startup … initdb: error: cannot be run as root`, in the
terminal the operator is already watching.

### Task 4 — preflight: refuse to launch as root

The bundle has an undocumented, unchecked host precondition. Give it a home.

- New exported `assertSupportedHost()` in `boot.ts`: currently one check —
  `process.getuid?.() === 0` ⇒ throw, naming the cause (Postgres' `initdb` refuses to
  run as root) and the remedy (create and run as a non-root user). Structured so
  further host preconditions land here rather than being rediscovered at runtime.
- Called first in `launch.ts`'s `main()` (before the `RELEASE.json` read) and in
  `cli/bin/commands/start.ts`.

Deliberately *not* in scope: auto-creating a user and dropping privileges. That is a
real feature (user creation, file ownership, re-exec) and a separate decision — flagged
below.

### Task 5 — docs

- `gateway/CLAUDE.md`, "Service supervision" section (lines ~172-196): it currently
  documents the keep-serving decision verbatim ("If a service fails, log loudly but
  keep serving"). Record the reversal, the startup-vs-watchdog split, and the new
  `error` field on the API.
- `plugins/database/plugins/embedded/CLAUDE.md`, "Status" section: the sample
  `/gateway/services/postgres/status` JSON gains `error`.
- `docs/setup.md`, Prerequisites: the non-root requirement.
- `plugins/infra/plugins/launcher/CLAUDE.md` is autogen-only today; add hand-written
  prose above the autogen block covering the boot ordering and the fail-fast wait.

## The side question: why logs land in two places

It is three places, and the split is by **process**, not by accident:

| sink | written by | contents |
|---|---|---|
| `<data>/logs/gateway.log` | Go gateway (slog, rotating) | routing, lifecycle, supervisor |
| `<data>/logs/<name>.log` | Go gateway (`pumpLog`) | that backend's stdout/stderr (+ zero-cache sidecar) |
| `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl` | the TS backend (`defineLogSink`) | the app's own structured channels |

This is mostly by design and mostly already unified: Debug → Logs merges (2) and (3)
into one viewer — (2) arrives over the gateway's `GET /gateway/worktrees/<name>/logs`
SSE stream, added precisely so a crash-looping backend stays diagnosable when the
backend itself is unreachable (`research/2026-04-14-global-backend-crash-logs.md`).
The gateway cannot write into (3): it is a separate Go process with no DB and a
different lifetime.

The one genuinely un-unified stream is `gateway.log` itself — no endpoint exposes it,
and no TypeScript reads it.

**But unifying the logs would not have fixed this bug**, and that is the important
part. The operator was running a release from a terminal, not browsing Debug → Logs —
and with no Postgres there is no backend, so there is no UI to browse. The diagnosis
has to travel as a **propagated error**, which is what tasks 1–3 do. Surfacing
`gateway.log` as a fourth channel in the viewer is a reasonable, cheap follow-up
(mirror the existing `/gateway/worktrees/<name>/logs` pattern with a `GET /gateway/log`
tail + a third `ChannelRef` source in `debug/logs/web/components/log-viewer.tsx`) —
it is left out of this plan to keep the fix focused, and is worth filing separately.

## Files

| file | change |
|---|---|
| `gateway/supervisor.go` | `lastErr` on `Service`, `setCrashed()`, `Error` on `ServiceSnapshot` |
| `gateway/main.go` | fatal exit + stderr on `StartAll` / `NewSupervisor` failure |
| `plugins/infra/plugins/launcher/server/internal/boot.ts` | `readLogTail`, `awaitGatewayReady`, `assertSupportedHost`, `awaitPgReady` onDeadline, `bootSelfContainedApp` ordering |
| `plugins/infra/plugins/launcher/server/index.ts` | export the two new functions |
| `plugins/infra/plugins/launcher/bin/launch.ts` | `assertSupportedHost()` first in `main()` |
| `plugins/framework/plugins/cli/bin/commands/start.ts` | `assertSupportedHost()` + `awaitGatewayReady()` instead of an unconditional success print |
| `gateway/CLAUDE.md`, `plugins/database/plugins/embedded/CLAUDE.md`, `docs/setup.md`, `plugins/infra/plugins/launcher/CLAUDE.md` | docs |

Reused rather than rebuilt: `isRunning` / `isGatewayListening` / `readPid`
(boot.ts:73-105), `retryUntil` + `exponential`
(`@plugins/packages/plugins/retry/core`), the existing `ServiceSnapshot` JSON routes
(`gateway/proxy.go:303-321`).

## Verification

1. `cd gateway && go build -o gateway . && go test ./...` — the supervisor has existing
   tests to extend; add one asserting `Get()` carries the error text after a failed
   start.
2. `./equin build`, then `./equin check` (type-check, boundaries, docs
   in sync).
3. **Reproduce the original failure without root.** Point a throwaway
   `database.json`'s `postgres.start` at a script that prints a distinctive string to
   stderr and exits 1, run the gateway against it, and confirm: the process exits
   non-zero; `gateway-stdio.log` contains the string; `gateway.log` contains the slog
   line.
4. **End-to-end launcher path.** With that same broken start command, run the release
   `launch` binary (or `./equin start`) and confirm the terminal shows the
   distinctive string within a few seconds — not `Postgres did not become reachable
   within 90000ms` at 90s.
5. **Root preflight.** `sudo <bundle>/launch` (or a container as uid 0) exits
   immediately with the non-root message and creates no data dir.
6. **No regression on the happy path.** A normal `./equin build` +
   `http://<worktree>.localhost:9000` still serves; `GET /gateway/services` shows
   `running` with no `error` field.
7. **Watchdog path unchanged.** With the gateway up, `pg_ctl stop` the cluster and
   confirm the gateway stays alive and `/gateway/services/postgres/status` reports
   `crashed` **with** an `error`.

## Deliberately out of scope

- **Auto-dropping privileges when started as root** (create a service user, chown the
  data root, re-exec). It would make a fresh Hetzner VPS work with zero operator steps,
  which is attractive given `sshUser` defaults to `root` — but it is a distinct feature
  with its own security surface.
- **`gateway.log` as a Debug → Logs channel** — see the side-question section.
