# Decouple the backend worktree socket dir from data-dir depth

## Context

Launching a release from a deep data directory makes the gateway reject the
backend **forever** with `worktree rejected … exceeds 104-byte limit`, and the
app never becomes ready.

Why: the per-worktree backend Unix socket lives at
`<SINGULARITY_DIR>/sockets/<name>.sock` (and `<name>.next.sock` for hot
restart). The gateway derives `SocketsDir` directly from `SINGULARITY_DIR`
(`gateway/main.go:49-59`), and enforces the macOS `sun_path` cap defensively in
`NewWorktree` (`gateway/worktree.go:26-28,223-228`, measuring the longer
`<SocketsDir>/<name>.next.sock` against `maxSocketPath = 104`). A release run
directly via `<out>/launch` sets `SINGULARITY_DIR ??= <out>/data` — a long
versioned path (`releases/<wt>/<comp>-<target>/<run-id>/data`) — so the socket
path inherits that depth and blows the cap.

The **embedded-Postgres and PgBouncer** sockets were already decoupled from this
depth: `launcher/bin/launch.ts:59-64` sets
`SINGULARITY_PG_SOCKET_DIR ??= mkdtempSync(join("/tmp", "sgs-"))`, and both
`plugins/database/plugins/embedded/shared/internal/paths.ts` and
`plugins/database/plugins/pgbouncer/shared/internal/paths.ts` read that single
override (falling back to `<SINGULARITY_DIR>/postgres/socket` when unset). The
**backend worktree socket was never given the same treatment** — that is the
asymmetry this change fixes.

`plugins/release/CLAUDE.md` currently claims *"The 104-byte Unix-socket cap no
longer constrains this path"* — true only for the PG/PgBouncer sockets, not the
backend worktree socket. That claim (and the near-identical comment in
`server/internal/out-dir.ts`) must be corrected.

**Intended outcome:** a release launched from any path (however deep) boots,
because the backend worktree socket dir is rerouted onto a short `/tmp` dir the
same way the PG sockets are; dev behavior is byte-identical (override unset →
`<SINGULARITY_DIR>/sockets` as today); docs tell the truth.

## Design

Mirror the `SINGULARITY_PG_SOCKET_DIR` precedent exactly, with a dedicated env
var for the worktree sockets dir. The gateway is the **single** place that
constructs the worktree socket path (the TS backend only reads `SOCKET_PATH`
from env, set by the gateway when it spawns the backend), so there is exactly
one consumer to teach the override — no codegen bridge, no second source.

1. **Gateway reads a `SINGULARITY_SOCKETS_DIR` env override** for the sockets
   dir default, falling back to `<SINGULARITY_DIR>/sockets`. This mirrors the
   existing env-defaulted-flag pattern already in this same function for
   `-default-namespace` (`main.go:62-67`, `os.Getenv("SINGULARITY_DEFAULT_NAMESPACE")`).
   The explicit `-sockets-dir` flag still wins if passed.

2. **`launch.ts` sets the override** to a short `/tmp` mkdtemp, next to the
   existing PG one, so the release gateway (spawned by `bootSelfContainedApp` →
   `spawnGatewayDaemon`, which inherits `process.env`) picks it up. A separate
   short dir (own env var) keeps the two socket concerns cleanly independent and
   avoids mixing PG's `.s.PGSQL.*` sockets with the gateway's `*.sock` scan set
   in `reconcileOrphanBackends`.

3. **Correct the docs/comments** that claim the cap is already lifted for this
   path.

Dev is unaffected: `SINGULARITY_SOCKETS_DIR` is unset outside a release, so the
gateway falls back to `<SINGULARITY_DIR>/sockets`, byte-identical to today.
Preview (`preview-manager.ts`) already uses a short `/tmp/sgp-XXXXXX` data root
and spawns the same `launch` binary, so it gains this decoupling for free (now
belt-and-suspenders).

## Changes

### 1. `gateway/main.go` (parseFlags, ~line 58)

Replace the unconditional `<dataDir>/sockets` default with an env-first default,
mirroring the `-default-namespace` pattern already in this function:

```go
defaultSockets := os.Getenv("SINGULARITY_SOCKETS_DIR")
if defaultSockets == "" {
	defaultSockets = filepath.Join(dataDir, "sockets")
}
flag.StringVar(&cfg.SocketsDir, "sockets-dir", defaultSockets,
	"directory for per-worktree Unix sockets (env: SINGULARITY_SOCKETS_DIR; short /tmp dir for deep release roots)")
```

### 2. `plugins/infra/plugins/launcher/bin/launch.ts` (~line 64, next to the PG socket line)

Add the worktree-socket decoupling and widen the existing comment to cover both:

```ts
// Reroot the embedded-PG / PgBouncer sockets AND the gateway's per-worktree
// backend sockets onto short `/tmp` paths (each read a single env override).
// The data root above may be a long versioned `<out>/data`
// (`releases/<wt>/<comp>-<target>/<run-id>/data`), which would blow the 104-byte
// AF_UNIX socket-path cap; the socket dirs are decoupled so length never
// constrains where a release is staged.
process.env.SINGULARITY_PG_SOCKET_DIR ??= mkdtempSync(join("/tmp", "sgs-"));
process.env.SINGULARITY_SOCKETS_DIR ??= mkdtempSync(join("/tmp", "sgw-"));
```

(`mkdtempSync` / `join` are already imported at the top of the file.)

### 3. `plugins/release/CLAUDE.md` (the "Versioned out-dir" bullet, ~lines 33-41)

Rewrite the socket claim so it names *all* the sockets that get rerouted. Change
the passage that reads *"reroots both the embedded-PG and PgBouncer sockets …"*
to state that `launch.ts` reroots the embedded-PG, PgBouncer, **and gateway
per-worktree backend** sockets onto short `/tmp` dirs (via
`SINGULARITY_PG_SOCKET_DIR` and `SINGULARITY_SOCKETS_DIR` respectively), so a
long `<run-id>` is safe even for a direct `<out>/launch`.

### 4. `plugins/release/server/internal/out-dir.ts` (comment, ~lines 22-25)

Update the near-identical inline comment the same way — it currently mentions
only the PG/PgBouncer reroute as the reason the versioned path is safe.

### 5. `gateway/CLAUDE.md` ("Path-length limit" section)

Add one sentence: the `~62 char` limit applies to the dev
`~/.singularity/sockets/` prefix; a packaged release reroots the sockets dir to
a short `/tmp` path via `SINGULARITY_SOCKETS_DIR` (set by `launch.ts`), so a deep
release data root does not constrain worktree names. (The dev limit itself is
unchanged.)

## Critical files

- `gateway/main.go:49-67` — `parseFlags`, `SocketsDir` default (env override goes here; `-default-namespace` is the precedent).
- `gateway/worktree.go:26-28,223-228` — `maxSocketPath` + `NewWorktree` cap enforcement (unchanged; this is what stops rejecting once SocketsDir is short).
- `plugins/infra/plugins/launcher/bin/launch.ts:59-64` — where the PG socket override is set; add the sockets override here.
- `gateway/worktree.go:256-262` — `primarySocketPath` / `secondarySocketPath` (read `cfg.SocketsDir`; no change needed — decoupling is upstream at the dir).
- `plugins/infra/plugins/launcher/server` (`spawnGatewayDaemon`) — spawns the gateway spreading `process.env`; already forwards the new var, no change needed.
- Docs: `plugins/release/CLAUDE.md`, `plugins/release/server/internal/out-dir.ts`, `gateway/CLAUDE.md`.

## Verification

1. **Build & deploy the worktree:** `./equin build` (rebuilds the gateway
   Go binary + TS backend). Confirm the dev app still comes up at
   `http://<worktree>.localhost:9000` — proves the unset-override fallback is
   byte-identical (dev sockets still at `<SINGULARITY_DIR>/sockets`).

2. **Gateway unit tests:** `cd gateway && go test ./...` — the existing cap tests
   (`registry_test.go`, `sockets_test.go`) must still pass (they build `Config`
   with an explicit `SocketsDir`, so the env-default change does not affect
   them). Optionally add a small `parseFlags`/env test asserting
   `SINGULARITY_SOCKETS_DIR` overrides the default while an explicit
   `-sockets-dir` flag still wins.

3. **End-to-end (the actual bug):** run a release into a deliberately deep out
   dir and launch it directly:
   - Produce an artifact whose `<out>` root is deep enough that
     `<out>/data/sockets/<comp>.next.sock` would exceed 104 bytes (e.g. via the
     Studio Release pane, or `./equin release --composition <c> <target> --dev --out <deep>/…/<run-id>`).
   - `<out>/launch &` and hit `http://<comp>.localhost:<port>` (or `/api/health/ready`).
   - **Before the fix:** gateway logs `worktree … exceeds 104-byte limit` and the
     backend never becomes ready.
   - **After the fix:** the launch log shows the sockets rerooted under
     `/tmp/sgw-XXXXXX`, the readiness probe returns `200`, and the page loads.
   - Sanity-check `ls /tmp/sgw-*` shows `<comp>.sock` living in the short dir.

4. **Checks:** `./equin check` (runs as part of build) — plugin
   boundaries / doc-in-sync remain green (no new cross-plugin edges; only a Go
   env read, a TS env set, and prose/comments changed).
