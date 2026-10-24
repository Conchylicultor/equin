# Web release target (F4) — compiled self-contained binary

> Status: implementation plan. F4 of the self-contained release vision.
> Category: `global` (cli, codegen, gateway, infra/launcher, database packaging).
> Parent: [`research/2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md) (§F4 + Risks).

## Context

Today an app composition can be **built** (F1: `./equin build --composition sonata` emits a filtered dist + filtered registries) and **booted** on an isolated data root (F3: `bootSelfContainedApp` / `serve-app` brings up gateway + embedded PG + the app DB under a `SINGULARITY_DIR` override). What's missing is a command that **emits a portable, deployable artifact** — something an operator drops on a fresh server and runs, with no dev checkout, no toolchain, nothing pre-installed.

This is F4: `./equin release --composition sonata --target web` → a single self-contained binary that serves Sonata on a fresh host. The gateway is retained inside the artifact (it remains the supervisor and the seam through which a future version can be hot-swapped — that upgrade UX is **deferred**, see below).

### Decisions locked with the user

1. **Path B — compile the TS entrypoints.** The backend, launcher, and the PG/PgBouncer start scripts are each compiled to native executables via `bun build --compile`. The import closure is computed **by the bundler, by construction** → the minimized server closure is exact. No bun runtime, no TS source, no Go toolchain on the host.
2. **Minimized closure by construction.** Implicit / dynamic imports that the bundler can't see are **bugs we fix** (static-ize them), not cases we accommodate.
3. **Single self-extracting binary is the default artifact.** `release --dev` stops at the raw staged directory (directly runnable, for inspection/debugging); plain `release` packs that tree into one shippable executable.
4. **Host needs nothing.** Only native binaries (gateway, Postgres, PgBouncer — vendored as files) and the compiled entrypoints ship. The artifact is **per OS/arch**.
5. **Hot-swap upgrade UX is deferred.** The gateway stays resident so a future upgrade is possible, but no `upgrade` command ships in v0. The choreography is documented at the end for later.
6. **Assume `bun --compile` works; fix native-dep failures as bugs** (no up-front spike step).

## Runtime model (what the artifact must reproduce)

The gateway is the supervisor and spawns everything else:

- **launcher** → starts the gateway daemon, then drives DB provisioning + spec registration (`bootSelfContainedApp`, `plugins/infra/plugins/launcher/server/internal/boot.ts`).
- **gateway** (Go) → long-lived; supervises PG + PgBouncer (from `database.json` `services[]`), lazy-spawns the **app backend** per namespace, serves `web/dist` statically, owns the readiness-gated `/restart`.
- **Postgres + PgBouncer** → native binaries, spawned by the gateway supervisor via each service's `start` command array.
- **app backend** → today `bun bin/index.ts` in `spec.Server`, hardcoded at `gateway/worktree.go:580`. **This is the one spawn contract Path B must make configurable.**
- **web dist** → filtered Vite output, served by the gateway.

Everything that was `bun X.ts` becomes a compiled binary; the gateway's spawn commands are repointed at those binaries. The **backend contract is unchanged** (reads `SOCKET_PATH` + `SINGULARITY_WORKTREE` from env, serves `/api/health/ready`), so a compiled backend hot-restarts identically.

## The release pipeline (`release.ts`)

`./equin release --composition <name> --target web [--dev] [--out <path>]`

1. **Composition build (reuse F1).** Run the existing `build --composition <name>` path to produce the filtered web `dist` and the filtered `server.composition.generated.ts` registry. (Invoke the build command's internals directly; do not shell out.)
2. **Compile entrypoints** with `bun build --compile` (target = host OS/arch, or `--target` later for cross-compile):
   - **backend** ← `plugins/framework/plugins/server-core/bin/index.ts`, with the registry import statically resolved to the **composition** registry (see "Static registry selection" below) → `server` binary.
   - **launcher** ← a thin entry calling `bootSelfContainedApp` with the packaged paths → `launch` binary (the artifact's entrypoint).
   - **pg-start** ← `plugins/database/plugins/embedded/scripts/start.ts` → `pg-start` binary.
   - **pgbouncer-start** ← `plugins/database/plugins/pgbouncer/scripts/start.ts` → `pgbouncer-start` binary.
3. **Vendor native binaries** into the staged layout: the prebuilt **gateway** (`go build -o gateway` for the target), the **embedded-postgres** native bin dir, the **pgbouncer** native bin. (These are platform-specific files, copied as-is — nothing to compile.)
4. **Assemble the staged directory** (the `--dev` output, also the input to packing).
5. **Default only:** **pack** the staged tree into one self-extracting binary.

## Key changes

### 1. Gateway: configurable backend-spawn command

`gateway/worktree.go` — `Spec` (line 59) gains an optional field; `startBackend` (line 580) uses it when present, else keeps the `bun bin/index.ts` convention:

```go
type Spec struct {
    Server  string   `json:"server"`            // working dir (cwd)
    Web     string   `json:"web"`
    Command []string `json:"command,omitempty"` // release: ["<abs>/server"]; dev: nil → bun bin/index.ts
}
```

```go
// startBackend
argv := spec.Command
if len(argv) == 0 {
    argv = []string{"bun", "bin/index.ts"}
}
cmd := exec.Command(argv[0], argv[1:]...)
cmd.Dir = spec.Server
// env (SOCKET_PATH, SINGULARITY_WORKTREE), SysProcAttr, readiness — all unchanged
```

`writeWorktreeSpec` (`plugins/infra/plugins/worktree/server/internal/spec.ts`) gains an optional `command?: string[]` passed through to `spec.json`. `bootSelfContainedApp` / `serve-app` thread it (release passes the compiled `server` binary path; dev passes nothing).

### 2. Static registry selection for the compiled backend

The server today selects its registry dynamically (`plugins/framework/plugins/server-core/bin/plugins-active.ts`: `await import(existsSync(filtered) ? filtered : full)`). A runtime-computed dynamic specifier defeats the bundler — the compiled backend must import the **filtered** registry **statically**, mirroring the web `@composition-web-registry` alias the parent doc established.

Introduce a symmetric server alias `@composition-server-registry`:
- **Dev runtime**: keep the existing existsSync selector (full vs filtered) — unchanged behavior.
- **Compile**: a `bun build` resolve that pins `@composition-server-registry` → `core/server.composition.generated.ts`, so the bundler's closure **is** the composition closure. (A missed dynamic import anywhere in that closure surfaces as a runtime "module not found" in the compiled backend — the "fix as a bug" case.)

### 3. `database.json` for the compiled release

`ensureDatabaseConfig` (`boot.ts:109`) currently writes service `start` arrays as `["bun","run",<startScript>]` and probes `node_modules` for embedded packages. A release has neither bun nor node_modules. Add a release path that writes the **same `DatabaseConfig` shape** with `start` pointing at the compiled binaries:

```jsonc
"services": [
  { "name": "postgres",  "start": ["<abs>/pg-start"],        "ready": { "unix": "<PG_SOCKET_DIR>/.s.PGSQL.5433" } },
  { "name": "pgbouncer", "start": ["<abs>/pgbouncer-start"], "ready": { "unix": "<PGBOUNCER_SOCKET_DIR>/.s.PGSQL.6432" } }
]
```

The `pg-start` / `pgbouncer-start` binaries resolve the **vendored native** PG/PgBouncer binaries. Their `resolveBinDir()` / `resolveBinary()` currently probe `node_modules/@embedded-postgres/...` and `node_modules/@equin/...` (`embedded/scripts/start.ts:44`, `pgbouncer/scripts/start.ts:38`). Vendor the native dirs at those exact relative paths under the bundle root so the compiled start scripts find them unchanged — or add a `SINGULARITY_PG_BIN_DIR` / `SINGULARITY_PGBOUNCER_BIN` env override resolved first (cleaner, avoids re-creating a `node_modules` shape in the bundle). Prefer the env override.

Data-dir/port isolation is already solved by F3: everything re-roots under `SINGULARITY_DIR`, and the release picks a release port (`serve-app` defaults 9100). The release launcher sets `SINGULARITY_DIR` to a per-install data dir and the bin-dir env overrides before importing anything (path constants are import-time frozen — `boot.ts:39`).

### 4. Staged bundle layout (`release --dev` output)

```
sonata-web-<ts>/
  launch                  # compiled launcher binary (entrypoint)
  server                  # compiled backend binary  (gateway spawns this)
  gateway/gateway         # prebuilt Go gateway binary
  pg/pg-start             # compiled PG start binary
  pg/native/bin/...       # vendored embedded-postgres native binaries
  pgbouncer/pgbouncer-start
  pgbouncer/native/bin/pgbouncer
  web/                    # filtered Vite dist (served statically)
  RELEASE.json            # { composition, target, platform, builtAt, port }
```

`launch` sets `SINGULARITY_DIR` (default: `<install-dir>/data` or an XDG path), sets the PG/PgBouncer bin-dir env overrides, then calls `bootSelfContainedApp({ name, server: <bundle>/, command: ["<bundle>/server"], web: "<bundle>/web", port, repoRoot: <bundle> })`. `buildOrLocateGateway` is replaced by a **locate-prebuilt** path (skip `go build` when `gateway/gateway` exists — small change to `boot.ts:189`).

### 5. Single self-extracting binary (default `release` output)

Pack the staged tree into one executable: `bun build --compile` a tiny **bootstrap** entry that embeds the staged tree as an embedded asset (tar), extracts it to a content-addressed cache dir (`<data>/runtime/<hash>/`) on first run (skip if present), then `exec`s the extracted `launch` binary. Result: `scp sonata-web . && ./sonata-web` → serving.

Embedding mechanism is an implementation detail to validate (Bun embedded-files vs. appended-tarball self-extractor); native binaries must be written with the executable bit on extraction. Treat extraction-path edge cases as fix-as-bugs.

### 6. CLI command

New `plugins/framework/plugins/cli/bin/commands/release.ts` exporting `registerRelease(program)`, registered in `plugins/framework/plugins/cli/bin/index.ts` (one import + one call, matching `registerServeApp`). Options: `--composition <name>` (required), `--target <web>` (default `web`; `tauri` is F5), `--dev` (emit staged dir, skip pack), `--out <path>` (default `dist/release/<name>-<target>-<ts>`).

## Hot-swap upgrade (deferred — documented for later)

Not built in v0, but the gateway is retained to enable it. Future flow, reusing the existing readiness-gated `/restart` (`gateway/proxy.go:212`, `worktree.go:356` — blue-green socket swap + drain, already zero-downtime):
1. Unpack the new version into a **new versioned dir** (blue-green on disk; never mutate the running version's files).
2. Atomically rewrite `spec.json` → new `server`/`command`/`web` paths (gateway debounces 100ms; web takes effect next request, server on next spawn).
3. `POST /gateway/worktrees/<name>/restart` → gateway spawns the new backend on the alternate socket, gates on `/api/health/ready`, swaps atomically, drains the old.
4. GC the old version dir after drain.

## Critical files

- `plugins/framework/plugins/cli/bin/commands/release.ts` (new) + `bin/index.ts` (register) — the command.
- `plugins/framework/plugins/cli/bin/commands/build.ts` — reuse the `--composition` build path.
- `gateway/worktree.go:59` (`Spec`), `:580` (`startBackend`) — configurable spawn command.
- `plugins/infra/plugins/worktree/server/internal/spec.ts` — thread `command` into `spec.json`.
- `plugins/infra/plugins/launcher/server/internal/boot.ts` — locate-prebuilt gateway (`:189`), release `database.json` writer (`:109`), thread `command` into `writeWorktreeSpec` (`:366`).
- `plugins/framework/plugins/server-core/bin/plugins-active.ts` — `@composition-server-registry` static alias for compile.
- `plugins/database/plugins/embedded/scripts/start.ts:44` + `plugins/database/plugins/pgbouncer/scripts/start.ts:38` — bin-dir env override for vendored natives.
- `plugins/infra/plugins/paths/core/internal/paths.ts:31` — `SINGULARITY_DIR` override (already the isolation lever; no change, just used).

## Verification

1. **`release --dev sonata`** → staged dir. On a clean root: `SINGULARITY_DIR=$(mktemp -d) <staged>/launch` → `http://sonata.localhost:9100` serves Sonata; confirm gateway + PG + backend all came from the bundle (no dev `~/.singularity`, no `go build`, no `node_modules`).
2. **`release sonata`** → single binary. Copy to a clean container/VM **with no bun, no Go, no node**; run it → serves. Proves full self-containment.
3. **Minimized closure**: confirm the compiled `server` binary boots only the composition `bundle` (Sonata plugins) — e.g. agent-manager/conversations endpoints 404; binary size reflects the closure, not all ~540 plugins.
4. **Dev unaffected**: a normal `./equin build` and `serve-app` still work (spec `command` absent → `bun bin/index.ts`); `plugins-registry-in-sync` green; git tree clean.

## Risks

- **`bun --compile` of the backend's native deps** (`pg`, `graphile-worker`, `@embedded-postgres` spawn shapes). `graphile-worker` reads `.sql` migration files at runtime — may need embedding or on-disk placement. Per decision: fix as bugs as they surface.
- **Dynamic `await import` in `plugins-active.ts`** — must be static-ized for the compiled backend (handled by the `@composition-server-registry` alias).
- **Platform-specific artifact** — native binaries make each release OS/arch-bound; cross-compile is future.
- **Self-extract edge cases** — exec bit on extracted natives, cache-dir collisions, partial-extract recovery. Fix as bugs.
- **asset-mirror cold start** (Sonata audio offline) — a web deploy is typically online so the mirror warms on first request; pre-seeding is primarily an F5 (Tauri/offline) concern, noted but out of scope here.
