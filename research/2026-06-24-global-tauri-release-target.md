# F5 — Tauri release target: package a composition as a self-contained desktop binary

> Status: implementation plan. Category: `global` (gateway, cli, launcher, database + a new `tauri/` Rust shell).
> Depends on F4 (web release target) — **implemented and reused verbatim**.
> Parent vision: [`research/2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md) (§F5 + Risks).

## Context

F1–F4 are **done**: `./equin release --composition sonata --target web` already produces a self-contained, portable bundle — compiled `server` + `launch` binaries, vendored gateway / embedded-Postgres / PgBouncer natives, the filtered web `dist`, and migration SQL — that boots the whole stack on a fresh host and serves Sonata at `http://sonata.localhost:9100`. The `--target tauri` branch is the only thing stubbed out (it `process.exit(1)`s with "F5 not yet implemented" in `release.ts:192`).

F5 wraps that **same bundle** in a Tauri (Rust) desktop shell: the shell spawns the existing `launch` binary as a sidecar (gateway + embedded Postgres come up as detached daemons), points its webview at the local gateway, stores data in the OS app-data dir, and tears the stack down on quit.

The one app-correctness problem F5 must solve is **single-origin routing**: a desktop webview has no `<name>.localhost` subdomain, so the gateway's `parseWorktree` returns `""` and 404s. Fix: a gateway **default-namespace** route.

> **Offline cold-start audio is explicitly out of this task** (filed as a follow-up — see below). The Tauri app will have working audio **online** (first launch lazily downloads the asset-mirror samples); fully-offline audio arrives once the generic prewarm follow-up lands. This is a known, accepted v0 caveat.

### Decisions locked with the user

- **Webview loads the live gateway URL** `http://localhost:<port>` (not bundled `dist` over `tauri://`). The gateway already serves the SPA statically *and* proxies `/api` + `/ws` from one origin — single-origin, no CORS, F4 reused unchanged. The default-namespace fix is what makes this work.
- **Host-platform app, unsigned.** v0 emits a runnable bundle for the current OS/arch (`.app`/`.dmg` on macOS) via `tauri build`. No code-signing / notarization, no cross-OS CI.
- **Prewarm deferred.** Pre-seeding instrument samples is app-specific and must not be hardcoded into the generic release pipeline or the Tauri shell. Filed as a separate follow-up to be designed as a generic, plugin-declared mechanism.

## What's reused (no change)

- `bootSelfContainedApp` / `writeReleaseDatabaseConfig` / `teardownSelfContainedApp` — `plugins/infra/plugins/launcher/server/internal/boot.ts`. The full bring-up (gateway daemon → `awaitPgReady` → `ensureDatabase` → `writeWorktreeSpec` → `awaitAppReady`) and the pidfile-based teardown already exist.
- `launch.ts` — `plugins/infra/plugins/launcher/bin/launch.ts`. Self-roots `SINGULARITY_DIR` under `dirname(execPath)/data`, honors a `SINGULARITY_DIR` / `PORT` override, reads `RELEASE.json`. The Tauri shell sets those env vars and runs it as-is.
- The whole `release --target web` staging pipeline in `release.ts` (composition build, `bun build --compile`, native vendoring, `RELEASE.json`).
- The gateway's `central_routes.go` precedent — a path/host-independent static route already overrides subdomain routing; default-namespace is the same shape, one notch lower in precedence.

---

## Components

### 1. Gateway default-namespace routing (`gateway/`)

The single load-bearing gateway change. When a request resolves to no namespace (bare `localhost`, no central-route match), fall back to a configured default.

- **`gateway/main.go`** — add `cfg.DefaultNamespace string`, parsed from a new `-default-namespace <name>` flag (default `""`, also overridable via a `SINGULARITY_DEFAULT_NAMESPACE` env read like `SINGULARITY_DIR`). Thread it into `NewProxy`.
- **`gateway/proxy.go` `ServeHTTP`** — after the central-routes block and before the `worktreeName == ""` 404 (currently `proxy.go:47–54`):
  ```go
  if worktreeName == "" && p.defaultNamespace != "" {
      worktreeName = p.defaultNamespace
  }
  ```
  Lowest precedence: explicit subdomain and central routes still win. Empty default = today's behavior exactly, so **dev and the web target are unaffected** unless they opt in.
- **Launcher passes it for every release.** `spawnGatewayDaemon` (`boot.ts:361`) gains a `defaultNamespace` opt appended as `-default-namespace <name>`; `bootSelfContainedApp` (`boot.ts:497`) forwards `name` into it. So **both** web and Tauri releases serve at bare `http://localhost:<port>/` — this also retro-fixes the web target and Windows (`*.localhost` doesn't resolve there). Dev `./equin start` does not set it.

### 2. PG socket dir decoupled from the data dir (`plugins/database/plugins/{embedded,pgbouncer}/`)

macOS app-data paths (`~/Library/Application Support/<bundle-id>/data/postgres/socket/.s.PGSQL.6432`) risk breaching the 104-byte `sun_path` limit for longer usernames / bundle ids. PG/PgBouncer sockets are ephemeral (recreated each start) — only the *data* must live in app-data. So:

- Add a `SINGULARITY_PG_SOCKET_DIR` env override consumed where `PG_SOCKET_DIR` / `PGBOUNCER_SOCKET_DIR` are derived (the embedded + pgbouncer server constants), defaulting to today's `<SINGULARITY_DIR>/postgres/socket` so **dev and the web target are byte-identical**. The PG/PgBouncer start scripts already read these constants for `unix_socket_directories` / `[pgbouncer] unix_socket_dir`, and the connection config + `ready.unix` probes derive from the same constants, so the override flows everywhere consistently.
- The Tauri shell sets it to a short, stable `/tmp/equin-<install-hash>/`. `/tmp` being reboot-cleared is fine — the socket is remade on each PG start; the cluster data persists in app-data.

### 3. `teardown` entrypoint (compiled binary in the bundle)

New `plugins/infra/plugins/launcher/bin/teardown.ts` — mirror of `launch.ts`'s env-rooting preamble (set `SINGULARITY_DIR` / `SINGULARITY_PG_SOCKET_DIR` before any import), then `await import` and call `teardownSelfContainedApp({ root: process.env.SINGULARITY_DIR, httpPort })`. `release.ts` compiles it to `out/teardown` alongside `launch`. Reuses the existing, idempotent teardown (gateway-first SIGTERM+wait → PgBouncer → Postgres) — it only signals pidfiles, it does **not** delete the data dir, so songs persist across restarts.

> Note: `teardownSelfContainedApp` SIGQUITs Postgres (immediate, crash-safe via WAL — written for ephemeral previews). For a persistent desktop install a graceful fast-shutdown (SIGINT) would be cleaner; WAL recovery on next boot makes SIGQUIT acceptable for v0. Flagged as a follow-up, not v0 scope.

### 4. Tauri shell — new `tauri/` Rust project (repo root, sibling of `gateway/`)

A committed scaffold; only the bundled resources vary per release. Tauri v2. **No app-specific code** — it reads everything (composition name, port) from the bundled `RELEASE.json`, so it packages any composition unchanged.

```
tauri/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json          # window, bundle id, resources → resources/bundle/**
│   ├── build.rs
│   ├── resources/bundle/        # GITIGNORED — release.ts copies the staged tree here
│   └── src/
│       ├── main.rs
│       └── lib.rs               # lifecycle: spawn launch → load URL → teardown on exit
```

**Lifecycle (`lib.rs`), Tauri `setup` + `RunEvent`:**

1. Resolve the bundled tree via `app.path().resource_dir()` → `<res>/bundle/{launch, teardown, RELEASE.json, …}`; read `RELEASE.json` for `composition` + `port`.
2. Compute data root: `app.path().app_data_dir()` → set env `SINGULARITY_DIR=<app_data>/data` (persistent, per-OS app-data — macOS `~/Library/Application Support/<bundle-id>/data`).
3. Set `SINGULARITY_PG_SOCKET_DIR` to a **short** path `/tmp/equin-<hash>` (§2) — keeps the PG/PgBouncer Unix socket under the 104-byte limit while data stays in app-data.
4. Port: use `RELEASE.json.port` (stable per install; overridable). **Detect-and-reuse:** if `GET http://localhost:<port>/gateway/worktrees` already answers (a prior session's detached daemons survived a crash), skip bring-up. Else spawn `bundle/launch` with the env above; it blocks until `awaitAppReady` then exits 0.
5. Create/show the main `WebviewWindow` at `http://localhost:<port>/` (single origin; default-namespace routes it to the composition backend).
6. On `RunEvent::ExitRequested` / `Exit`: run `bundle/teardown` (§3) with the same env, wait, then proceed to exit. The detached daemons (gateway `unref`'d, `pg_ctl` fork) are *not* Tauri-owned children, so teardown via pidfiles under `SINGULARITY_DIR` is the authoritative stop.

Use `tauri-plugin-shell` (or `std::process::Command`) for the sidecar spawns. The `launch`/`teardown`/`server`/native binaries are shipped as **bundle resources** (not Tauri `externalBin` sidecars) because Tauri SIGKILLs `externalBin` children on exit (no graceful path) — but our daemons are detached and outlive `launch`, so we manage their lifecycle explicitly instead.

### 5. `release.ts` tauri branch + target registry

- **`plugins/release/core/targets.ts`** — add the one-line entry (the file's own comment says so):
  ```ts
  { id: "tauri", label: "Desktop (Tauri)", implemented: true, buildArgs: () => ["--target", "tauri"] },
  ```
- **`plugins/framework/plugins/cli/bin/commands/release.ts`** — remove the `target !== "web"` rejection (`:192`). After the existing web staging (steps 1–3 produce the staged `out/` tree), for `--target tauri`:
  1. Compile the `teardown` entrypoint (§3) into `out/teardown`.
  2. Copy the staged `out/` tree into `tauri/src-tauri/resources/bundle/`.
  3. Generate the `tauri.conf.json` values that vary (productName, bundle identifier `com.equin.<composition>`, window title) from the composition; keep the rest static.
  4. Run `tauri build` (via `bun x @tauri-apps/cli@2 build` or `cargo tauri build`) for the host platform; copy the produced `.app`/`.dmg` (macOS) or `.deb`/`.AppImage` (Linux) into the release `out/` and print its path.
  - `--dev` short-circuits to a `tauri dev`-style run (skip bundling) for fast iteration.

---

## Lifecycle summary

```
App launch
  └─ Tauri setup:
       set SINGULARITY_DIR=<app-data>/data, SINGULARITY_PG_SOCKET_DIR=/tmp/equin-<hash>, PORT
       if gateway already listening on PORT → reuse; else spawn bundle/launch (one-shot)
          launch → bootSelfContainedApp: gateway daemon → PG ready → ensureDatabase
                   → writeWorktreeSpec(default-namespace routes bare localhost here)
                   → migrate-on-boot → awaitAppReady → exit 0
       WebviewWindow.load("http://localhost:<PORT>/")
App quit (RunEvent::Exit)
  └─ spawn bundle/teardown → gateway SIGTERM+wait → PgBouncer → Postgres ; data persists
```

## Critical files

**New**
- `tauri/src-tauri/{Cargo.toml, tauri.conf.json, build.rs, src/main.rs, src/lib.rs}` — the Rust desktop shell.
- `plugins/infra/plugins/launcher/bin/teardown.ts` — compiled teardown entrypoint.

**Modified**
- `gateway/main.go` — `-default-namespace` flag + `SINGULARITY_DEFAULT_NAMESPACE` env, into `NewProxy`.
- `gateway/proxy.go` — default-namespace fallback in `ServeHTTP` (after central routes, before 404); `Proxy.defaultNamespace` field + `NewProxy` param.
- `plugins/infra/plugins/launcher/server/internal/boot.ts` — `defaultNamespace` opt on `spawnGatewayDaemon` + `bootSelfContainedApp`.
- `plugins/framework/plugins/cli/bin/commands/release.ts` — tauri branch (compile `teardown`, copy bundle into `tauri/resources/bundle/`, generate conf, run `tauri build`); drop the rejection.
- `plugins/release/core/targets.ts` — add the `tauri` target entry.
- `plugins/database/plugins/embedded/server` + `plugins/database/plugins/pgbouncer/server` — `SINGULARITY_PG_SOCKET_DIR` override on the socket-dir constants (default unchanged).
- `.gitignore` — `tauri/src-tauri/resources/bundle/`, `tauri/src-tauri/target/`.

## Deferred / follow-up (filed separately)

- **Generic asset-mirror prewarm (offline audio).** Each plugin that registers a mirror should be able to declare a *seed* (which files / how to enumerate), and the release pipeline runs a generic "warm all mirrors in this composition's closure" step that bakes the cache into the bundle; the launcher copy-if-absents it into the app-data cache on first run. App-specific warm-up logic (e.g. "play the piano") must live with the plugin, never in the release/tauri code. Until then, Tauri audio is online-first.
- **Graceful persistent-PG shutdown** (SIGINT vs SIGQUIT in teardown).
- **Code-signing / notarization + cross-platform CI.**

## Risks / open sub-decisions

- **Tauri toolchain on the build host.** `tauri build` needs Rust + the platform webview SDK (macOS: Xcode CLT + system WKWebView; Linux: `libwebkit2gtk`). v0 targets the dev's host only; document the prerequisite. No bun/Go/Rust toolchain is needed on the *end-user* machine — the bundle ships compiled binaries + system webview.
- **Stable port → multi-instance collision.** A second copy of the same app (or a stale survivor on the same port) is handled by detect-and-reuse; truly concurrent independent instances are out of v0 scope.
- **`resource_dir()` path resolution** differs across `.app` (Contents/Resources) vs `tauri dev` (target dir). Resolve via the Tauri path API, never hardcode; verify both in the `--dev` and bundled runs.

## Verification (end to end)

1. **Gateway routing (dev loop, isolated):** `./equin build --composition sonata`, then start a gateway with `-default-namespace sonata` and confirm bare `http://localhost:9000/` serves Sonata (today it 404s); confirm a normal dev gateway (no flag) still 404s bare localhost and unaffected subdomains still route.
2. **Bundle build:** `./equin release --composition sonata --target tauri` → a `.app`/`.dmg` is produced for the host platform.
3. **Launch (online):** launch the app on a clean machine (no `~/.singularity`); confirm the window loads Sonata, a song saved persists across an app restart (data in app-data dir), and audio plays (online lazy-download).
4. **Teardown:** quit the app; confirm no orphaned gateway / postgres / pgbouncer processes remain (`pgrep`), the app-data PG cluster + sockets are released, and relaunch still has the data.
