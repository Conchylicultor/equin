# Gateway

Reverse proxy that multiplexes multiple equin app instances (one per agent worktree) behind a single port using subdomain-based routing.

See the top-level [`CLAUDE.md`](../CLAUDE.md) for overall architecture and [`server-core/CLAUDE.md`](../plugins/framework/plugins/server-core/CLAUDE.md) for the backend.

## What It Does

- Listens on loopback port 9000 (`-listen loopback:9000`: one listener on `127.0.0.1:9000`, one on `[::1]:9000`, one `http.Server`), routes `<name>.localhost:9000` → that worktree's backend
- Serves each worktree's `web/dist` as static files directly (no backend spawn needed for page loads)
- Lazy-spawns the backend on a page load (in the background, beside the SPA shell) or the first `/api/*` or `/ws/*` request; tears it down after 10 minutes idle — except the namespace it serves to the public (below)
- **Never sweeps a deployed site's backend.** The namespace a gateway serves at its `-public-hosts` is derived, never named: a public host has no `<name>.localhost` label, so it can only reach `-default-namespace` (`Config.publicNamespace`; public hosts without a default namespace are fatal at boot). Idle sweeping frees memory from backends nobody uses; a public site's one backend being "idle" only moves its cold start (~0.8 s) onto the next visitor — about five times a day on the website box before this (2026-11-13). A dev gateway, desktop app or preview passes no public hosts and is swept as before. `/stop` and `?hold=1` still stop it (a data reset must be able to).
- Hands each backend a Unix domain socket at `~/.equin/sockets/<name>.sock` as `--socket <path>` on its argv. Gateway dials the socket directly — no TCP between gateway and backend.
- Starts every child (backends, supervised services) from a **declared** environment, never its own: see "Backend Contract", item 2.
- Discovers worktrees from `~/.equin/worktrees/<name>/spec.json`
- Exposes `/gateway/*` on every host as an API for apps to query gateway state
- **Supervises configured services** (e.g. embedded Postgres) via a generic process supervisor. See "Service supervision" below.
- **Triggers main's deploy** (`-main-checkout`): on every advance of `refs/heads/main` it runs `./equin build --allow-main --converge` in main's checkout, one run at a time. See "Main's deploy" below.
- **Is replaced by main's deploy when main changes it**: that same run rebuilds this binary and restarts it — no one runs `./equin start --force` for a pushed gateway change. See "The gateway follows main" below.

## Key Design Decisions

- **Subdomain routing, not path-prefix** — each instance thinks it's at `/`, so no base-path rewriting. `*.localhost` resolves natively in Chrome and Firefox
- **Gateway serves statics, backend serves API/WS** — separating the cheap thing (files) from the expensive thing (process) means page loads are instant and backends only exist when needed. A page load still *starts* the backend (without waiting on it), so its boot overlaps the browser loading the app instead of following it
- **Gateway owns backend lifecycles** — backends are spawned, supervised, and killed by the gateway. They never know the gateway exists. The convention is `bun bin/index.ts --namespace <name> --socket <path> --principal-stamped` in the `server` directory, with the declared runtime environment and nothing else (`backendLaunch` in `worktree.go`)
- **Children get a declared environment, not an inherited one** — the gateway used to hand every child its own environment, i.e. whatever its starter carried. Started from an agent shell, that put the shell's `EQUIN_CONVERSATION_ID`, `TMUX` and `CLAUDE_*` into every backend on the host. Now the launcher declares the names (`-child-env`), `env.go` captures that subset once at boot, and `env.go` is the only file allowed to call `os.Environ()` or `exec.Command` (the `launcher:gateway-env-explicit` check) — so no exec site can fall back to Go's nil-`Env` "inherit everything"
- **Unix domain sockets, not TCP loopback** — eliminates the IPv4/IPv6 bind-shape asymmetry that allowed unrelated processes to silently steal traffic on macOS (an IPv4-loopback squatter could coexist with a dual-stack listener on the same port). UDS scopes the gateway↔backend channel by filesystem path, removes the port allocator entirely, and removes any LAN-exposure surface.
- **Loopback front door, both families** — the gateway's own port binds `127.0.0.1` and `[::1]` as two listeners (`listenAddrs` in `main.go`), never one dual-stack wildcard, so it is unreachable off-box (and trips no macOS incoming-connections prompt) and no IPv4- or IPv6-loopback squatter can coexist with it on the port: `[::1]` in use is fatal, like `127.0.0.1`; only `[::1]` *unavailable* (no IPv6) degrades to IPv4 with a warning. Every interface is the explicit `-listen :<port>` (`EQUIN_LISTEN=:<port>`).
- **`/gateway/*` is a reserved path** on every host — the gateway intercepts it before proxying. Apps call `GET /gateway/worktrees` to list instances. This is an official API, not internal plumbing

## Routing Rules

```
/gateway/*       → gateway's own API (intercepted before proxying)
/api/*           → proxy to backend (lazy-spawn if needed)
/ws/*            → proxy to backend (WebSocket upgrade via http.Hijacker)
/robots.txt, /sitemap.xml → proxy to backend (exact paths only: backendRootPaths)
everything else  → static file from web/dist (SPA fallback for extensionless paths);
                   serving the shell to a document navigation also starts the backend in the background
```

**The shell carries a server-rendered head.** `serveShell` splices the entry of
`<registry-dir>/<name>/document-head.json` (written by the backend —
`shell/document-head`) whose key is the longest app path the request is in
(`""` otherwise) before `</head>`: the theme's CSS for the first frame
(`document_head.go`). The bytes then vary by path and theme, so the response
carries an ETag hashed from them (still `no-cache`: unchanged → 304). No file,
or one this gateway cannot read (logged at error) → the plain shell. An
explicit `/index.html` still gets `http.ServeFile`'s redirect.

**A crawlable composition's shell carries its page's static snapshot**
(`snapshot.go`; design: `research/2026-11-10-global-website-crawlable-v3.md`).
When `<web>/snapshot/manifest.json` (crawlable's `SnapshotManifestSchema`,
mirrored strictly: unknown fields refused) lists the request path — cleaned,
trailing slash dropped, query ignored — `serveShell` replaces the shell's
`<title>`, adds `<meta name="description">`, `<link rel="canonical">` (origin
from `Host` + `X-Forwarded-Proto`, http by default; the href is the manifest
key) and the hiding rule (`html.js #equin-snapshot{display:none}` plus the
script setting `js`) before `</head>`, and the fragment file wrapped in
`<div id="equin-snapshot">` right after `<div id="root"></div>`. Title,
description and href are HTML-escaped; the fragment is the build's own HTML,
inserted verbatim (UTF-8). It composes with the document head (both splices,
one ETag over the final bytes, prefix `sh-`). The manifest and every fragment
are read together from the RESOLVED dist (`EvalSymlinks` of the `web`
symlink) and cached per web dir until the resolved dist or the manifest's
inode/mtime changes — a build is a symlink swap, so it is always a miss; a
shell request otherwise costs a readlink and a stat. No manifest → the plain
shell. **An unusable snapshot is a 500, never the plain shell** (logged once
per revision): a malformed manifest fails every shell of that dist (which
paths it lists is unknowable), a listed page whose fragment is missing fails
that path only, as does a listed page on a shell with no root div. Serving the
plain shell instead would look fine in a browser while silently hiding the
page from every crawler. The build must write the fragments before the
manifest (renamed into place), inside one dist. **Bare `/` is a 301 to the
manifest's `home`** (the composition's home app's base path, query kept),
when it names one: the app redirects `/` only once its JS runs, so a crawler
would otherwise read an empty shell at the site's most-linked address. `home`
is checked as strictly as the schema: a page path other than `/` that `pages`
lists (null refused; absent = no redirect).

`/robots.txt` and `/sitemap.xml` are forwarded to the backend whatever the
dist holds (the `crawlable` server plugin answers, 404 with no pages). Every
proxied HTTP request carries `X-Forwarded-Host` (the visitor's `Host`,
overwriting a client value — the backend itself is addressed as `backend`) and
`X-Forwarded-Proto` (a front proxy's value kept, else `http`); see
`newReverseProxy`.

The running gateway is main's: a worktree's `./equin build` does not rebuild
it, so a gateway change takes effect once it lands on main — main's deploy
restarts the gateway on its own (see "The gateway follows main"; a release
bundle carries its own gateway).

`/api/*` and `/ws/*` are the same prefixes as the Vite dev proxy in `web/vite.config.ts`.

**Static files are served precompressed, never compressed per request**
(`encoding.go`). Every dist file is write-once, so the build writes `<file>.br`
and `<file>.gz` beside each compressible one when it publishes it (web-artifacts
`core/internal/precompress.ts`); `serveStaticFile` — the one file serve every
static path uses — picks `br`, then `gzip`, from `Accept-Encoding` (an explicit
`q=0` refuses), sets the ORIGINAL file's `Content-Type` by extension (unknown →
`application/octet-stream`, never sniffed off compressed bytes) and
`Vary: Accept-Encoding` on any file that has sidecars. No sidecar, not accepted,
or a `Range` request → identity via `http.ServeFile`, as before. The one dynamic
body, the head-spliced shell, is gzipped on the fly (`serveBytes`; its ETag gets
a `-gzip` suffix). `/artifacts/*` is additionally `immutable` (content-addressed);
the shell is `no-cache`.

## Principal (who a request is)

`principal.go` turns every request into `owner` or `anonymous` (`principalOf`) and `Proxy.ServeHTTP` stamps it as `X-Equin-Principal` first thing, deleting any client-sent value (the HTTP reverse proxy and the WebSocket `r.Write` replay both carry it). The gateway's own direct-socket calls (`/api/health/ready`, `/api/boot/gateway-report`) stamp `owner`. The backends enforce per-route access from the header; the gateway itself refuses two things, `403 {"reason":"cross-site-refused",...}`: an anonymous non-GET/HEAD `/gateway/*` call, and any anonymous WebSocket upgrade. Same-origin, not same-site:

1. Host not an equin host (no namespace, not `localhost`/`127.0.0.1`/`::1`, not in `-public-hosts`) -> anonymous (DNS rebinding). `-public-hosts` (comma-separated) is how a deployed site, whose Caddy forwards the public Host unchanged, names its own hostnames; the launcher passes it from `EQUIN_PUBLIC_HOSTS`.
2. `Sec-Fetch-Site` `same-origin` or `none` -> owner.
3. No `Sec-Fetch-Site` and no `Origin` -> owner (local tools).
4. No `Sec-Fetch-Site`, `Origin` == `http://<Host>` or `https://<Host>` -> owner (old browsers).
5. Otherwise anonymous (cross-site, sibling namespace, `Origin: null`).

**The handshake.** Every backend (central included) gets the bare `--principal-stamped` at the end of its argv (`principalStampedFlag`, `backendLaunch`): "this gateway stamps the header". A backend enforces fail-closed — a missing header is anonymous — only when it sees the flag (`readPrincipalStamp`, `plugins/framework/plugins/principal`). The gateway binary is a shared dependency a worktree's `./equin build` neither rebuilds nor restarts (main's deploy restarts it once a change lands — "The gateway follows main"), so a backend can boot behind a gateway older than the stamp; without the handshake it would refuse everything, this gateway's own readiness probe included, and every namespace would stay down. Behind such a gateway the backend serves ungated (the pre-principal status quo), logs `[principal] this gateway predates the principal stamp …` at boot, and the health report's Gateway row turns stale. **The protection takes effect once the gateway is restarted — which main's deploy does by itself after the push that changes it (by hand: `./equin start --force`).** The flag and the Go constant are pinned to the TS one by `principal:header-in-sync`.

Design: [`research/2026-10-28-global-http-edge-principal.md`](../research/2026-10-28-global-http-edge-principal.md).

## Content host

`content.go`: `http://<item>.content.localhost:<port>/<ns-label>/api/…` is where
equin serves untrusted CONTENT (an agent-written prototype) off every app
origin — one origin per `<item>` (one DNS label, not otherwise read), the
namespace in the first path segment (alias-resolved like a Host). Handled
first in `ServeHTTP`, before `parseWorktree` and central routes. The gateway
stamps principal `content` (client value deleted), proxies only `/api/…` (path
rewritten without the label) to that namespace's backend, sets
`Content-Security-Policy: frame-ancestors 'self' http://*.localhost:<port>`,
`Cross-Origin-Resource-Policy: same-origin` and `nosniff`, and refuses
everything else with `{"reason":"content-refused"}`: the SPA, `/gateway`,
`/ws` and any WebSocket upgrade, Service Worker scripts. The backend serves
only routes declared `access: { content }` to that principal. `content` and
`<x>.content` are reserved namespace names (`namespaceCollision`);
`contentHostLabel` is pinned to the TS constant by `namespace:grammar-in-sync`.
Design: [`research/2026-10-29-global-content-isolation.md`](../research/2026-10-29-global-content-isolation.md).

## Worktree Registry

Location: `~/.equin/worktrees/<name>/spec.json`. Directory name = worktree identifier = subdomain.

```json
{
  "server": "/absolute/path/to/server",
  "web": "/absolute/path/to/web/dist"
}
```

`server` is required and absolute; `web` is absolute when present (central has none). Optional `command` (argv to spawn instead of the bun convention) and `env` (full variable names → values, applied on top of the declared child env when the backend is spawned — a same-named entry is replaced; keys non-empty, no `=`, else the spec is rejected). `env` is how what belongs to the code a spec runs (a release bundle's own paths) travels with that spec instead of being inherited from whoever started the gateway. The gateway hardcodes the launch convention (`bun bin/index.ts --namespace <name> --socket <path> --principal-stamped`, escalating readiness timeout — see "Backend Contract"). No per-worktree overrides in v1. Other per-worktree files (build logs, profiling data) also live in the same subdirectory.

Composition namespaces (`http://<composition>.<checkout>.localhost:9000`, or `http://<composition>.localhost:9000` when the checkout is main — `./equin build --composition <name>`) are ordinary spec dirs written by the build: `server` points at the checkout that built it, `web` at a composed dist, plus a `composition.json` provenance marker the gateway ignores. No gateway changes; namespace identity flows the same way (dir name → the backend's `--namespace`). The `composition` field on the spec is carried through the gateway's round-trip but never interpreted or forwarded — the backend reads it back off the same file.

### Discovery: dir-level watch + lazy resolve + periodic reconcile

Registration is decoupled from fsnotify so it cannot silently fail at scale. Three layers (`registry.go`):

1. **Single dir-level fsnotify watch** on the registry dir (1 FD). Catches subdir create/remove for low latency. It does **NOT** add a watch per worktree subdir — with thousands of worktree dirs that exhausts the macOS kqueue/open-file budget, and a dropped per-subdir `w.Add` loses the worktree forever (the build creates the subdir early for logs, then writes `spec.json` last, so the later write is the event that goes unobserved). That was the prior silent-failure bug.

   **Only the `<name>/spec.json` subdir layout is recognized.** The old flat `<name>.json` spec layout (written by pre-May-2026 CLI versions) has been **retired** from all scan paths (`LoadAll`, `Watch`, `Reconcile`). `Resolve` (the request path) was always subdir-only, so a flat-only spec was already unroutable — nothing relied on the flat scan. Retiring it also stops the gateway from re-parsing the unrelated `*-build-profile.json` / `*-build-logs.json` profiling artifacts that share the registry dir as if they were specs (they have no `server` field), which previously emitted ~1.3k `failed to load legacy spec` warnings on every boot/reconcile. `removeWorktreeSpec` still deletes any leftover flat `<name>.json` defensively.
2. **Lazy `Registry.Resolve(name)`** on the request path (`proxy.go`). If a host has no registered worktree but `<name>/spec.json` exists on disk, it is loaded and registered on demand — so any worktree whose spec is on disk is reachable on its **first request**, regardless of watch health.
3. **Periodic `Registry.Reconcile`** (`-reconcile-interval`, default 10s) re-scans the dir as a backstop: registers any `spec.json` the watch missed (keeping `GET /gateway/worktrees` eventually-consistent) and unregisters worktrees whose backing dir vanished (e.g. removed by `worktree-cleanup`). This is the watch+reconcile informer pattern; reconcile skips already-registered dirs so it stays cheap even with thousands.

Net effect: `spec.json` on disk ⟺ worktree reachable. The watch is a latency optimization, never a correctness dependency.

### A rewritten `spec.json` is picked up

A registered worktree re-reads its spec when — and only when — the file on disk is a revision it has not loaded. Each `Spec` carries the fingerprint of the file it was parsed from (`specRev`, an unexported field so spec and provenance ride one atomic pointer and cannot disagree). Triggered by `reconcileOnce` (stat per tick) and by `Registry.RefreshSpec`, which a body-less `POST /gateway/worktrees/<name>/restart` calls *before* restarting — so a build that writes `spec.json` then POSTs doesn't race the tick. (A restart carrying its spec in the body never refreshes — see "Zero-downtime restart".)

- **Keyed on `(mtime, size, dev, ino)`, not mtime+size.** The writer uses atomic temp+rename, so on a coarse-mtime filesystem two same-length rewrites in one second look identical — but a renamed-into-place file always has a new inode. A content hash is equally exact and ~10× the cost (a read of every spec, every tick) for a question the stat already answers.
- **`loadSpec` opens once and stats the fd, not the path** — the recorded revision must describe the bytes actually parsed. Statting the path could pair a new file's fingerprint with old content, recording as loaded a revision that never was.
- **Cost:** one `os.Stat` per subdir per tick, ~12µs each ⇒ ~1ms at ~90 namespaces, 0.01% of a core at the default 10s. The `ReadDir` that pass already did costs a fifth of that.
- **A load failure changes nothing and never evicts.** Malformed / truncated / absent / schema-invalid, or a rewrite naming a `server` path that doesn't exist: the previous spec stays live. Unregistration stays keyed on **dir** presence only.
- **Spec writes are serialized** (`Worktree.specMu`): an adoption (`adoptSpec`) also re-stats the file and declines a revision that is no longer the one on disk, so a read that raced a deploy's commit can never undo it.
- **The revision check lives in `upsert`**, not its callers — so `LoadAll`/`Watch`/`Resolve`/`Reconcile` may all call `loadFile` unconditionally with no churn, and the reconcile stat gate is purely a cost optimization.

When a change applies (see `UpdateSpec`'s docblock): `web` on the **next request** (`handleStatic` re-reads it per request, no respawn); `server`/`command` on the **next spawn** — `Ensure`/`Restart` snapshot the spec before `startBackend`, so refreshing alone restarts nothing.

### Self-healing stale registrations (dead `spec.Server`)

The registry subdir (`~/.equin/worktrees/<name>/`, holding `spec.json` + logs) is a *different* path from `spec.Server` (the git worktree's server dir, e.g. `<repo>/.claude/worktrees/<name>/plugins/.../server-core`). The subdir can outlive the worktree it points at — `worktree-cleanup` or a manual `git worktree remove` can delete the git worktree while leaving the registry subdir behind. Such a registration is born-dead: it can only ever fail to spawn (`cmd.Dir = spec.Server` does not exist).

`registry.go` evicts these defensively (`serverPathMissing`, ENOENT-only so a transient stat error never evicts a live worktree):

- `loadFile`/`loadLegacyFile` refuse to register a spec whose `spec.Server` is already gone — so boot `LoadAll`, lazy `Resolve`, and the watch never admit a dead entry.
- `reconcileOnce` also unregisters a *previously-registered* worktree once its `spec.Server` disappears (the registry-subdir presence check alone never fires, because that subdir is still on disk).

The gateway never deletes the on-disk registry subdir itself (that is `worktree-cleanup`'s job) — it only keeps `byName` honest.

## File Structure

Flat single-package layout:

```
gateway/
├── main.go        # Flags, wiring, signal handling, sockets-dir setup, service bring-up
├── env.go         # ChildEnv: the declared environment every child starts from; the only os.Environ()/exec.Command site
├── worktree.go    # Worktree lifecycle transitions (Ensure, Restart, Stop, exit), spawn, readiness
├── lifecycle.go   # The lifecycle as one value: the phase union and the spawnAttempt every waiter shares
├── handler_panic.go # A request-handler panic recovered into a 500 and filed as a gateway-panic report
├── deploy_spec.go # Spec parsing/validation, the restart route's candidate body, its commit to memory + spec.json
├── registry.go    # Map of worktrees: dir-level fsnotify watch + lazy Resolve + periodic Reconcile, idle sweeper, stale-socket sweep
├── supervisor.go  # Generic service supervisor: start commands, readiness probes, watchdog
├── logrelay.go    # Relay mode (`gateway -log-relay <path>`): a supervised daemon's output through a rotating writer
├── namespace_logs.go # A namespace's log channel deleted with its registry dir (on unregister, and a boot sweep)
├── document_head.go # The backend-rendered <head> fragment spliced into the SPA shell
├── snapshot.go    # A crawlable dist's static page snapshot (manifest + fragments) spliced into the shell
├── encoding.go    # Content-encoding of statics: precompressed-sidecar negotiation, on-the-fly gzip of the spliced shell
├── principal.go   # principalOf: owner/anonymous verdict, X-Equin-Principal stamp, cross-site refusal
├── content.go     # the content host: <item>.content.localhost/<ns>/api/… stamped `content`, nothing else served
├── crash_report.go # The report outbox writer; a backend's signal death as a backend-crash entry
├── exit_report.go # Every unrequested backend death filed (backend-exit for an exit code) and counted into crash loops (backend-crash-loop)
├── service_report.go # A supervised service's mid-session outage filed as a service-down report (same outbox writer)
├── main_deploy.go # Main's deploy trigger: watches refs/heads/main, runs one convergence run at a time, files main-deploy-failed
└── proxy.go       # http.Handler: routing, static serving, HTTP/WS proxy, /gateway API
```

Logic belongs with the data it operates on: spawn/stop/readiness are methods on `Worktree`, discovery/sweeping are methods on `Registry`, all request handling is in `Proxy.ServeHTTP`, service lifecycle is on `Supervisor`.

## Zero-downtime restart

`POST /gateway/worktrees/<name>/restart` performs a hot restart when the backend is already running. The gateway spawns a new backend on an alternate socket (`<name>.next.sock`) while the old one keeps serving. Once the new backend is ready, the proxy pointer is swapped atomically — new requests go to the new process, in-flight requests and WebSocket connections finish on the old one. The old backend then drains and exits.

Two socket paths per worktree: `<name>.sock` (primary) and `<name>.next.sock` (secondary). They alternate on each restart — the gateway always spawns on whichever socket the current backend is NOT using. The `backend` struct groups per-process state (cmd, exitCh, proxy, socket path, WS conn count) so two backends can coexist briefly during the swap window.

If the new backend fails to start (bad code, broken migration), the old backend stays up and the restart returns an error. Failed deploys cause zero downtime.

**The route, two forms** (`deployRestart`; `{"restarted":true}` on success, `500` + the reason on failure; idle/broken → a deploy cold start, a boot in flight waited out first):

- **No body** — the build wrote `spec.json` first; the route `RefreshSpec`s, then restarts on it.
- **`{"spec": <spec.json object>}`** (`deploy_spec.go`) — validated exactly as a file load (`400` otherwise, nothing spawned). The gateway boots the **candidate** (`Restart(ctx, cand)` / `DeployStart`) and commits it — `spec.json` by temp + rename (the bytes as sent, so unknown fields survive; the in-memory spec stamped with that file's revision, so no refresh re-adopts it) and the in-memory spec — in the same `w.mu` critical section that makes its backend the serving one. Before that, static serving (`wt.Spec().Web`) and any respawn still see the old spec; on any failure both stay exactly as they were, so the next cold start (idle sweep, then a request) boots what last worked, never the failed build.

State machine during restart: `Running → Restarting → Running`. During `Restarting`, `Ensure()` returns the old proxy immediately (no blocking, no 502). The idle sweeper skips worktrees in `Restarting` state. `Stop()` waits for an in-flight restart to settle before proceeding.

### The lifecycle is one value (`lifecycle.go`)

The state and the backend it holds are ONE value, `phase` (`phaseIdle{held}`, `phaseStarting{spawn}`, `phaseRunning{bk}`, `phaseRestarting{serving, next}`, `phaseStopping{bk}`, `phaseBroken{err, until}`), written by one assignment under `w.mu`. `phaseRunning` is built only by `runningOn(bk)`, which asserts a ready backend with its proxy — so "running with no backend" has no spelling, and `Ensure` returning `nil` error always comes with a backend. Before, `state` and `active` were separate fields every transition wrote separately; on 2026-11-08 18:21 an exit and a hot restart's swap interleaved into `running` with `active == nil`, and every request to main panicked for 11 minutes.

**Phases end by identity, never by state alone.** `phaseStarting` is ended only by the boot that owns its `spawnAttempt`; `phaseRunning` only by the exit of exactly its backend, `Stop`, or `Restart`. A draining predecessor or a lost spawn cannot clear a phase that names another backend.

**The serving backend exiting mid-restart** hands the in-flight successor its waiters: `phaseRestarting{serving, next}` → `phaseStarting{next}`. Requests wait on the successor's boot rather than cold-spawning a rival beside it (which is what raced the swap in the incident); the restart then ends that phase — running on the successor, or broken with its failure (`hot restart failed, and the old backend exited during it`).

**Socket cleanup is by identity too** (`releaseBackendArtifacts`): a backend's socket and pid sidecar are removed only while the sidecar on its path still names its pid. Both socket paths are reused, and the drain of an already-dead backend used to unlink its successor's fresh socket by path (the incident's `dial unix …: no such file or directory` on main's primary socket). The pre-spawn unlink of a stale path stays path-based.

## Start priority

Every `Ensure` names a `StartReason`, which sets the spawn's priority:

- **Browser** — a document navigation (`Sec-Fetch-Dest: document`), or a WebSocket with `Sec-Fetch-Mode: websocket` and an `Origin` (agents' Playwright browsers included). Spawns at default priority.
- **Background** — everything else: the app's own `fetch()`es, MCP tools, scripts, other servers. Spawns darwinbg (`taskpolicy -b`). Main and central are never demoted.
- **Deploy** — the restart route a build POSTs, and the eager central start: background priority too, and the one background start that retries a failed boot (see "A failed boot is not retried by traffic").
- **Promotion is the backend's own act, on the gateway's word.** A process can leave darwinbg itself, but `taskpolicy -B -p <pid>` from outside exits 0 and changes nothing (measured 2026-10-31 and 2026-11-05), so the gateway does not call it. Every readiness probe carries `X-Equin-Boot-Tier: background | foreground` (`bootTierHeader`) — the tier the gateway wants the boot in — and the backend leaves darwinbg on the first probe that says `foreground` (spawn-priority's `followGatewayBootTier`, logged `[boot] scheduling tier on the gateway's word: …`, journaled as the `left-darwinbg` checkpoint). It says so once a browser joins the start or the boot escalates (`promoteBackend` flips `bk.demoted` under the worktree's `mu`; the probe reads it). Once ready the backend leaves on its own regardless (`[boot] scheduling tier once ready: …`). The header is stripped from every proxied request, and pinned to the TypeScript constant by `spawn-priority:boot-tier-in-sync`. Before this, a demoted boot ran darwinbg to the end: on 2026-11-04 worktree boots spent 60–100 s importing their plugins (2–9 s in the foreground; file reads measured 6–15× slower under darwinbg at load 25–30) and were SIGKILLed at the deadline.
- Every start that spawns logs `backend start requested … reason=… cause=…` — which request asked (kind, method, path, fetch metadata, Origin, User-Agent): the one record of who keeps asking for a worktree.

**Page-load start** (`serveShell` → `prestartBackend`): when `handleStatic` serves the SPA shell (directly or as the fallback) to a document navigation, it starts the backend with a browser reason in a goroutine, on a context that outlives the request. The response never waits on it and never fails because of it; a failed spawn is logged, and the app's own `/api` or `/ws` request reports it. Without this, the server is first asked for only after the browser has loaded and run the app (~4.5 s), and then the whole boot follows. Assets never start anything, and neither do headless worktrees (they have no shell). A running or starting backend is deduped by `Ensure`. A page load counts as activity, so a backend nothing else uses is swept after the usual idle timeout.

## A failed boot is not retried by traffic

A spawn that fails (killed at its readiness deadline, or exited before ready) leaves the worktree `broken`, its error in `lastSpawnErr`. A **background** request to a broken worktree is answered `502` with `ErrBootFailed` ("the backend's last boot failed, and background requests do not retry it — redeploy it … or open it in a browser") plus the failure, and spawns nothing. A **deploy** (the restart route) or a **browser** start (a person) retries it, after the `-broken-cooldown`. The pinned `central` keeps the plain cooldown retry (backends depend on it).

Before, the next request after the 10 s cooldown respawned it, whoever sent it — and the requesters were agents' readiness loops (`until curl …/api/health; do sleep 5; done`, often backgrounded and outliving the agent's attention): on 2026-11-04 one worktree was spawned and SIGKILLed 43 times, ~105 s of boot each, while every retry redid the same cold work under the same load that made it miss the deadline. A blind retry turned one failure into a loop whose only output was load.

## Stop on demand

`POST /gateway/worktrees/<name>/stop` is the idle sweeper's teardown on request (the cold-start benchmark's reset step): the same `Worktree.Stop` (waits out an in-flight spawn or restart, SIGTERM → grace → SIGKILL, socket + sidecar removed), leaving the worktree registered at `idle` so the next page load or `/api/*` / `/ws/*` request cold-starts it.

- `200` + the worktree's `WorktreeStatus` JSON (the `GET /gateway/worktrees` element shape) once the backend has exited. Already idle (or broken) → `200`, no-op.
- `409` for a pinned worktree (`Worktree.Pinned`, today `central`) — the same rule that keeps the sweeper off it. Main (`mainNamespace`) is not pinned: the sweeper stops it too.
- `503` when another stop is already tearing it down (not yet exited — retry); `404` for an unknown worktree; `500` if the stop fails. The stop runs on the request's context without its cancellation: a caller hanging up must not turn the SIGTERM grace into an instant SIGKILL, so a stop that arrives mid-spawn waits that spawn out even if its caller has gone. The idle sweeper stops the same way, and stops sweeping once shutdown begins (shutdown's `StopAll` takes the rest, inside its budget).

**`?hold=1` — stop and hold it down** (`Worktree.StopHeld`): the same stop, but the worktree is left `idle` with `held: true` in its status, and traffic cannot leave it — a browser or background `Ensure` gets `ErrHeld` (`502`), never a cold start. Only a **deploy start** (the restart route, `deployRestart` → `Ensure(StartDeploy)`) releases it. It is the step before destroying a namespace's data — taken by `holdBackendDown` (`plugins/infra/plugins/worktree/plugins/backend-hold`), whose `HeldBackend` is what `database/admin`'s `dropDatabase` / `recreateDatabase` require for a namespace's database: a composition reset, a namespace reclaim, a checkout reap and `./equin db fork --replace` drop the database the backend booted on, and must have no backend alive — or able to come alive — while it does (report-1794167098-q99s8d: the reset used to drop it under the serving backend and then hot-restart, which by design kept the OLD backend serving against the empty database until it crashed). The hold is set in the same critical section that ends the stop; holding an already-idle or broken worktree holds it too; a hold requested while another stop is mid-teardown answers `503` rather than lose the hold. In memory only: a gateway restart releases it.

## Shutdown fits one budget

On SIGTERM the gateway drains its HTTP server, then stops every backend, inside
ONE deadline, `-shutdown-timeout` (`shutdown.go`, `shutdownWithin`; the
launcher passes login-services' `SERVICE_SHUTDOWN_BUDGET_S`, 15 s, inside the
20 s its service manager SIGKILLs at). The drain gets what is left after the
stops' share (one `-shutdown-grace` plus `postKillTimeout`); requests still open
then end when their backend stops. The stops run under a context ending
`postKillTimeout` before the deadline, and `terminateBackend` sends SIGKILL when
its context ends, not only after its grace. Before, each step had its own clock: the
drain took its full 15 s whenever one proxied stream was open (a stream never
ends on its own), then a backend's 5 s grace started — 15 + 5 = launchd's
`ExitTimeOut`, so launchd killed the gateway mid-teardown (2026-11-08 18:05).

## Main's deploy

`main_deploy.go`. The gateway is the one process up whenever anything is, so
main's auto-deploy is TRIGGERED here — and only triggered. Before, every edge
and the runner lived in main's own backend, so a main that could not serve
could not deploy the commit that fixed it (2026-11-08: the fix sat eleven
minutes until a person reloaded this gateway).

- **Enabled by `-main-checkout <path>`**, which only `./equin start`'s dev launch
  passes (`devGatewayLaunchOptions`): a release, `serve-app` or a hand-run
  gateway deploys nothing. A path that is not a main checkout (a `.git` dir and
  an `equin` CLI) is fatal at boot, after the services start.
- **No policy.** On an edge, with no run going, it starts ONE
  `<checkout>/equin build --allow-main --converge` (cwd the checkout, the
  declared child env plus `EQUIN_BUILD_DETACHED=1`). That run decides from
  durable state whether anything is due and builds it
  (`plugins/build/plugins/converge`) — the commit being deployed decides with
  its own code.
- **Edges:** `refs/heads/main` moved (trailing debounce, 5 s), this gateway's
  boot, and `POST /gateway/deploy/converge {"cause": "…"}` (a backend: a
  composition config change, the composition cadence tick). An edge during a
  run is remembered and starts one more run when it exits; edges never queue
  more than that.
- **The watch** is fsnotify on `.git/refs/heads` and `.git` (loose ref and
  `packed-refs`). ANY event there re-reads `refs/heads/main`, and only a changed
  value is an edge: kqueue coalesces a directory's changes, so two quick
  lock-and-renames can arrive as the first one's events alone. A 30 s re-read is
  the backstop for an event never delivered — the registry's watch+reconcile
  pattern, two small file reads a tick.
- **The run outlives the gateway.** It is a deploy: its own process group, its
  output written straight into `<log-dir>/deploy/main.log` (rotated to `.1`
  past 16 MB before a run starts; not a pipe into this process), and
  `EQUIN_BUILD_DETACHED` keeps the CLI's orphan guard from exiting it. A
  restarted gateway's boot edge starts a run that waits behind it on the
  checkout's build lock.
- **Nothing retries.** A run that exits non-zero, is killed, or cannot start is
  filed as a `main-deploy-failed` report (its causes, status and last 60 log
  lines; kind `plugins/build/plugins/converge`, contract
  `testdata/main-deploy-failed-entry.json`), and the next edge is the next try.
  A failed BUILD is not a failed run: the run exits 0 and the build's row and
  bell say so.
- **API:** `GET /gateway/deploy` — the ref last seen, whether a run goes (and
  its pid), the pending edges, the last run's causes, times and outcome.
  `POST /gateway/deploy/converge` — an edge, `202`. Both `404` on a gateway
  without `-main-checkout`.

## The gateway follows main

Main's deploy also replaces the gateway itself — no person, no approval
(decided 2026-11-11: fixes in `gateway/` sat inert for days until someone ran
`./equin start --force`). After its builds, whatever their verdict, the
convergence run calls `followMainGateway` (`plugins/infra/plugins/launcher/plugins/gateway-drift`,
`cli/`):

- **When.** Only in main's checkout, only for the machine's login-service
  gateway, and only when this checkout is the one it deploys
  (`-main-checkout`). It builds main's `gateway-binary` (a hash when
  unchanged), then asks the health row's own comparison
  (`compareGatewayLaunch`: binary identity, every flag, cwd, signature,
  running vs installed) plus the whole rendered job (`LoginService.isCurrent`
  — the environment, which this run starts from: the gateway's own declared
  one). Current → nothing. So it covers everything the binary
  or its launch spec is built from: `gateway/**/*.go`, `go.mod`/`go.sum`, Go
  itself, and any flag derivation (`gatewayLaunchFlags` — a new `-child-env`
  name, a new data dir flag, the PATH rule).
- **How.** `start --force`'s path: install main's build into the equin app,
  write the job, `reloadService` (unload, wait out the old process, load),
  then `awaitGatewayReady` (alive and listening — and listening implies every
  supervised service came up). Every backend stops with the old gateway (the
  "Shutdown fits one budget" teardown) and cold-starts on its next request,
  central eagerly. What outlives it: agents (detached), Postgres / PgBouncer and
  their log relays (reattached), and this run (its own process group —
  measured 2026-11-11 on macOS 26: `launchctl bootout` kills the job's process
  group and leaves a child that `setpgid`'d alone, reparented to pid 1; systemd
  is `KillMode=process`). One window remains: a run killed between the unload
  and the load leaves the job unloaded until the next login. A tab
  reconnects its socket; an agent's build that POSTs its restart in the gap
  finds no gateway, which it treats as "spawns on the next request".
- **Never no gateway.** Before touching anything it captures the way back: the
  job definition verbatim (`LoginService.readDefinition`; a new job may carry a
  flag the old binary rejects) and the build the `machine-gateway` holder keeps
  (`heldDep`) — the hold moves to the new build only once it answers. No held
  build: it refuses. A new gateway that does not come up is replaced by the
  previous one (reinstalled, definition restored, reloaded, awaited).
- **Once per launch.** The launch's key (a hash of the build, argv, cwd and
  the environment's names — never its values, which this run inherits and a
  value differing run to run would mint a key per boot) is
  recorded in `state/gateway-follow/last-attempt.json` before the swap and never
  tried twice, whatever its outcome — every gateway boot starts a convergence
  run, so a failing launch would otherwise be retried by its own rollback's
  boot forever. A machine-wide flock (`follow.lock`) makes the successor's
  boot-edge run wait for this one, then find the gateway current.
- **Serialized with `start`.** `./equin start` takes the same `follow.lock`
  around its gateway half.
- **Loud.** A refusal or failure files a `gateway-restart-failed` report itself
  (the gateway that would have filed the run's exit is the one it replaced),
  and the health report's Gateway row stays Out of date until a later launch
  succeeds.

`./equin start --force` remains the by-hand path (first install, a
`gateway-restart-failed` fixed outside main, a host with main's deploy off).

## Service supervision

The gateway includes a generic service supervisor (`supervisor.go`) that manages long-lived daemons defined in the `-db-config` file. The gateway knows nothing about what services are — it just executes start commands, probes readiness, and runs watchdogs.

### Config file: `-db-config` (default `~/.equin/state/db-config/database.json`)

Auto-generated on first `./equin start`. Contains two sections:
- `connection` — database host/port/user, read by the server and CLI (not by the gateway)
- `services` — array of processes the gateway should supervise

Each service has a `start` command (executed synchronously), a `ready` probe (`{"unix": "<path>"}` or `{"tcp": "<host:port>"}`), and an optional `watchdog` interval.

### A service's output: the log relay

A supervised daemon never owns a log file. Every start (boot and watchdog re-start) spawns a **log relay** first (`logrelay.go`): a copy of this binary in relay mode, `gateway -log-relay <log-dir>/services/<service>.log`, in its own session, reading a pipe and writing it through the same `rotatingWriter` (and bound) as every other channel. The start command gets the pipe's write end as fd 3 and `--log-fd 3` appended to its argv (argv, not env: the daemon would inherit an env var for life); it hands that fd to the daemon as stdout/stderr (`pg_ctl -l /dev/fd/3`; PgBouncer in the foreground, no `logfile`). The gateway then closes its copies.

- **Outlives the gateway**, like the daemon: the relay reads until every process holding the write end has exited, so a gateway restart that reattaches leaves both running (verified: relays reparent to pid 1 and keep writing). Not a pipe into the gateway process, which the first restart would cut.
- **A start that only reattaches** never hands the fd on, so its relay reads EOF at once and exits without opening the file.
- **The trade**, shared with Postgres's own `logging_collector`: a relay that stopped reading would block the daemon's stderr writes once the pipe buffer fills (the relay only appends to a local file), and lines over `PIPE_BUF` (512 B on macOS) from concurrent Postgres backends can interleave. A dead relay costs log lines, not the daemon: Postgres and PgBouncer ignore SIGPIPE.
- **Behind an older gateway** (no `--log-fd`), the start scripts say so and fall back: Postgres to its old unrotated `postgres/postgres.log`, PgBouncer to `-d` with no log. Restart the gateway (main's deploy does once the change lands; by hand `./equin start --force`) and then the cluster.

`serviceLogsSubdir`, `serviceLogFdFlag`, `maxLogBytes` and `maxLogBackups` are pinned to their TypeScript twins (`infra/launcher/gateway-logs`) by `gateway-logs:in-sync`.

### Bootstrap order on a cold gateway start:

1. `Supervisor.StartAll(ctx)` runs synchronously in main — for each service, executes the start command, waits for the readiness probe to succeed, then arms the watchdog goroutine.
2. `central` worktree is eagerly spawned in a goroutine — by this point services are ready, so central plugins can connect immediately.

### A startup failure is fatal; a mid-session death is not

If `StartAll` fails, the gateway logs the error, writes it to stderr, and **exits non-zero**. It does not fall through to serving. A gateway whose managed Postgres never came up can serve static files and nothing else, so "continuing" bought nothing: it converted a startup failure that names its cause (`initdb: error: cannot be run as root`) into an unrelated-looking timeout 90 seconds later in a different process (`connect ENOENT …/.s.PGSQL.5433`). The stderr write is load-bearing, not redundant with `gateway.log`: the launcher opens `gateway-stdio.log` in `"w"` mode, so that file is truncated per start and holds exactly this boot's fatal error with no scrollback to read past — it is what the launcher quotes back to the operator's terminal. A malformed `database.json` is fatal for the same reason; a **missing** one is not, since that is the legitimate externally-managed-database case.

Because `StartAll` runs before `ListenAndServe`, **"the gateway is listening" implies "every managed service came up"** — which is what lets the launcher (`boot.ts`, `awaitGatewayReady`) wait on the gateway port rather than on a service's socket, and fail in seconds with the real cause.

The **watchdog deliberately does not share this policy.** A service that dies mid-session records its reason and the gateway stays up: killing it would tear down every live backend over a transient blip. Startup and steady state are different situations and get different answers — at startup nothing is running yet, so exiting costs nothing and buys a precise diagnosis.

### Watchdog

Each service's watchdog dials its readiness probe every N seconds (default 2). On failure, attempts one re-execution of the start command. If that also fails, marks the service Crashed and stops watching.

**A start command is bounded** (`execStartCommand`): boot and the watchdog both wait on it, and one that never returns used to leave its service down, unwatched and unreported. It runs in its own process group; at `defaultStartCommandTimeout` (5 min) — or when the gateway shuts down — the whole group is SIGKILLed (helpers such as `pg_ctl` with it; never the daemon, which `setsid`s into its own session) and the start fails with the bound and the output so far, so the outage is filed `crashed` with that reason. A command that exits while a process it started still holds its output pipe (a daemon that never detached its stdio) fails after `startCommandWaitDelay` (5 s), naming that, instead of `CombinedOutput` waiting out the daemon's life. The bound is a backstop around processes the gateway does not control, not what keeps the known start scripts finite: each bounds its own waits (`pg_ctl -t 30`, PgBouncer's 30 s readiness loop, the cluster session's 60 s per-call deadline — the one wait that had no bound, found 2026-11-08: a postmaster alive but not answering hung the Postgres script's reattach in `connect()` forever).

**Every outage is filed as a report** (`service_report.go`): once it settles — answering again after the re-start (`recovered`) or left `crashed` — the watchdog writes one `service-down` entry into the report outbox (`-report-outbox-dir`, the backend-crash writer), which main drains into `reports`. Generic over services: the payload is the probe and the dial's error, when the service last became running, the start command's output (a fresh start vs a reattach says whether it was really dead), and the last 60 lines of its `services/<name>.log` as of the detection. Before, the only record was the in-memory `crashed` state — and nothing at all for an outage the re-start recovered. Kind and schema: `plugins/debug/plugins/service-down` (contract pinned by `testdata/service-down-entry.json`).

### API

- `GET /gateway/services` — JSON array of all services with their states
- `GET /gateway/services/<name>/status` — JSON object for one service

Both carry an optional `error` alongside `name`/`state`: the reason the service last crashed (start-command stderr, or the readiness timeout), recorded atomically with the state transition by `setCrashed`. It is `omitempty`, so a healthy service's JSON is unchanged from before the field existed, and reaching `running` clears it. A `crashed` state with no reason attached is an absorbable failure — a value a consumer cannot act on — which is exactly what left the original incident undiagnosable.

If `database.json` is missing or has an empty `services` array, the supervisor does nothing (equivalent to using an externally managed database).

## Logging

Each channel gets its own size-rotated file under `-log-dir` (default `~/.equin/logs/gateway/`), so one channel's volume can't bury another:

- `gateway.log` — the gateway's own `slog` output (lifecycle, routing, supervisor). Written directly by the Go process via a rotating writer. Every backend the gateway kills or abandons leaves a line here: `backend abandoned: not ready by its deadline` (cold start or hot restart — pid, socket, deadline, waited, escalated, outcome, error; `abandonUnreadyBackend`), `backend killed: still running after SIGTERM grace` (stop / drain; `terminateBackend`), and `hot restart failed; old backend intact`. The backend's own log just stops at a kill, so this is the only record of it.
- `<name>.log` — one file per worktree, holding that backend's stdout/stderr (`central.log`, `<worktree>.log`, …). Each line is `<RFC3339> [stdout|stderr] <line>`. Backend output never lands in `gateway.log`. This is the durable counterpart to the in-memory `logRing` that feeds the live UI. **Deleted with the namespace** (`namespace_logs.go`): once a namespace's registry dir is gone, its unregistration removes `<name>.log` and its rotations after the backend's last lines are written; and at boot `LoadAll` sweeps the files of every namespace whose registry dir is gone (reaped while no gateway ran). A per-file bound is not a bound on the folder while the number of files is unbounded — 2,898 dead namespaces' logs (1.9 GB) had piled up by 2026-11-04. A registration evicted only because its server dir vanished keeps its logs.
- `services/<service>.log` — each supervised daemon's stdout/stderr (`postgres.log`, `pgbouncer.log`), written by its log relay (see "Service supervision").
- `gateway-stdio.log` — the daemon's raw stdout/stderr (Go panics, any crash before `slog` is wired up). Owned by the launcher (`./equin start`), truncated on each start.

Rotation (`logwriter.go`, `rotatingWriter`) is size-based: at `maxLogBytes` (50 MB) the active file becomes `<file>.1`, older backups shift up, and the oldest past `maxLogBackups` (5) is dropped — so each channel is capped at ~300 MB with no external dependency. The per-worktree writer opens lazily and is closed when the worktree is unregistered. Every file here is claimed on the `logs/gateway` data dir (`infra/launcher/gateway-logs`) for `paths:logs-claimed`.

## Build & Run

The machine's gateway binary is the `gateway-binary` dependency
(`plugins/infra/plugins/launcher/deps`, an `infra/deps` `build` kind): built from
this directory's Go source into `~/.equin/cache/deps/gateway-binary/<identity>/env/gateway`
by `./equin start` (or `./equin deps install gateway-binary`), rebuilt
whenever a `.go` file, `go.mod`/`go.sum` or Go itself changes, and sealed into
every release bundle (`deps/gateway-binary/gateway`, cross-compiled for its
platform). By hand, for a debugger:

```sh
go build -o /tmp/gateway .
/tmp/gateway -child-env HOME,USER,PATH                   # minimal hand-run; defaults: loopback:9000, ~/.equin/worktrees/
/tmp/gateway -child-env HOME,USER,PATH -listen loopback:8080 -idle-timeout 5m -log-level debug
```

`-child-env` is **required**: a comma-separated list of the environment variable names children may receive (an entry ending in `*`, like `EQUIN_AUTH_*`, matches a prefix). Without it the gateway exits non-zero before doing anything. It has no Go-side default on purpose — the declaration lives in one place, `runtimeEnvNames()` in `plugins/infra/plugins/launcher/plugins/runtime-env/core`, and `./equin start` passes exactly that. The minimal form above is enough to poke at routing under a debugger; a backend that needs more (the app's installation settings, OAuth credentials) needs the full list (`readEnv` in `env.go` reads `EQUIN_<key>`). At boot `gateway.log` records the forwarded names at info and, at warn, every name in the gateway's own environment it is NOT forwarding — the normal path drops nothing, so a warn line means a hand-run gateway. Names only, never values.

## Backend Contract

The gateway expects backends to:

1. Read their socket path from `--socket <path>` on argv (required; backends should error out if missing). A socket is per process, so it must not ride in the environment, where every process the backend starts would inherit it. The server-side reader is `readServingSocket()` in `plugins/infra/plugins/runtime-identity/core`. (A spec written while the transition ran may still carry a `socketTransport` key; the gateway ignores it.)
2. **Expect a declared environment, nothing ambient.** A backend receives exactly the declared runtime environment — the names the launcher passes via `-child-env` (`runtimeEnvNames()` in `plugins/infra/plugins/launcher/plugins/runtime-env/core`), with the values the gateway itself was started with — and nothing else. Nothing is inherited from whoever started the gateway: an undeclared variable in the starting shell never reaches a backend. A per-child value overrides a same-named base entry. Supervised-service start commands (Postgres, PgBouncer) and the gateway's own helper execs (`taskpolicy`, `ps`) get the base alone. A new variable a backend must read goes on the launcher's list — declaring it there is the whole change: `-child-env` changes, so main's deploy restarts the gateway once it lands (the value is the one the gateway was started with).
3. Bind that Unix socket and accept HTTP/1.1 + WebSocket connections on it. The gateway polls readiness via `GET /api/health/ready` over the socket — it hot-swaps only once that returns `200` (backend fully ready: migrations applied, DB warm, registry built), not on a bare socket accept. A `404` (backend predates the readiness endpoint) falls back to "HTTP-reachable = ready"; `503` means still booting.

   **Wedge detection is progress-aware and escalates before it kills.** The base deadline (`-ready-timeout`, load-adaptive up to `-ready-timeout-max`) is only the wedge *threshold*: when it expires but the backend has answered HTTP at all (even `503`), or was spawned darwinbg-demoted (an E-core boot legitimately exceeds base under host load — even to first socket bind), the gateway tells the backend to leave darwinbg (its next readiness probe says `foreground`, see "Start priority") and extends the wait by `-ready-timeout-max` instead of SIGKILLing near-complete boot work. Only a silent, never-demoted backend is declared wedged at base; a crashed backend is always caught instantly via its exit channel. This closes the 2026-07-07 spawn-kill loop, where healthy demoted boots were killed at 15s four times in a row under load, turning a slow cold start into a ~2-minute outage.
4. Use relative redirects (gateway does not rewrite `Location` headers)
5. Handle `/api/*` and `/ws/*` routes
6. Gate routes on `X-Equin-Principal` only when given `--principal-stamped` (see "Principal" → the handshake); without it, serve ungated and say so.

In Bun: `Bun.serve({ unix: readServingSocket(), fetch, websocket })`. There is no standalone dev mode — the backend is always spawned by the gateway.

## Every backend death the gateway did not cause is reported

A process killed by a signal (a segfault inside Bun or a native addon, an
abort, a kill from outside) runs none of its own handlers, so it cannot report
itself. The gateway is the one witness — it holds the wait status and the
process's stderr — so `crash_report.go` files it: `onBackendExit` sees a signal
death the gateway did not send (`backend.signalled`, set by `signalBackend`
before every kill it makes) and writes one `backend-crash` entry into the
report outbox (`-report-outbox-dir`, `reports/outbox`'s `state/report-outbox`),
which main's backend drains into `reports` — main's own crash on its successor's
boot. Any backend: worktrees, main, central.

**An exit by code is filed too** (`exit_report.go`), as `backend-exit` (the
code, whether it died booting or how long after ready, its stderr tail). It was
assumed to report itself, but the process that dies is the one least able to:
on 2026-11-08 main exited 1 about every 10 s, 83 times in 28 minutes, and its
own crash reports folded into a four-day-old rate-limited rejection row — no
record said "main is dying". "Unrequested" is the one rule for both: the
gateway did not signal it (`backend.signalled`); a SIGTERM stop that exits 0
is the gateway's act, an exit 0 nobody asked for is a death.

**A worktree that keeps dying is a crash loop** (`crashLoops`, per worktree):
`crashLoopThreshold` (3) deaths, each within `crashLoopWindow` (5 min) of the
previous, file a `backend-crash-loop` entry — again each time the count doubles
(6, 12, 24, …), and once when the loop ends (no death for the window, with the
backend's state then: `running` / `idle` / `broken`). It is a summary on top:
every death is still its own entry, so nothing is muted below a threshold.
Main's own loop waits in the outbox until a main backend lives long enough to
drain it. Kinds: `plugins/debug/plugins/backend-crash` (goldens
`testdata/backend-exit-entry.json`, `testdata/backend-crash-loop-entry.json`).

The entry carries the dead process's own last 60 stderr lines (Bun's panic
block and `bun.report` link): **stderr is a pipe the gateway owns**
(`os.Pipe`, not `cmd.StderrPipe`, whose read end `cmd.Wait` closes as soon as
the process exits — dropping the panic block still buffered in it), read until
EOF, bounded at 2 s for a grandchild holding it open. The payload is a
cross-language contract: `testdata/backend-crash-entry.json` is read by this
writer's test and by `plugins/debug/plugins/backend-crash`'s schema test.

## A handler panic is reported

`Proxy.ServeHTTP` defers `recoverHandlerPanic` (`handler_panic.go`) first thing: a panic in any handler answers `500` with the panic's text, is logged at error with its stack (`gateway handler panicked`), and is filed as a `gateway-panic` entry in the report outbox, coalesced per panic site (the function it was raised in): the first at once, the rest within a minute as one counted entry. `http.ErrAbortHandler` passes through unreported. Before, net/http's own recover wrote one `http: panic serving` line and dropped the connection — 240+ of them on 2026-11-08, and no report. Kind and schema: `plugins/debug/plugins/gateway-panic` (contract pinned by `testdata/gateway-panic-entry.json`).

## Orphan-backend reaping & stale-socket cleanup

The gateway owns backend lifecycles, but tracks live backends only in memory — so a gateway crash/restart (or `./equin start` re-launch) could leave the previous generation's backends orphaned. Cleanup has three layers:

1. **Durable pid sidecar** — at spawn, `startBackend` writes `<socket>.pid` (JSON: `pid`, `pgid`, `wallStart`, `worktree`) next to the socket, atomically (temp + rename). It is removed with the socket everywhere via `removeBackendArtifacts(socketPath)` (socket-first, then sidecar). This makes the gateway's ownership of a backend survive its own restart.
2. **Per-spawn unlink-before-bind** — `removeBackendArtifacts(socketPath)` immediately before each spawn, clearing any socket + sidecar a crashed predecessor left on that path.
3. **Boot reconcile** (`reconcileOrphanBackends`, replaces the old name-based `sweepStaleSockets`) — runs once at startup, **before** any backend is spawned, so the gateway owns zero backends and *any* process still bound to a worktree socket is an orphan from a prior generation. Per socket: a bare `net.Dial` is the liveness gate (a wedged-but-bound backend still completes the connect — reap it). **Not live** → remove socket + sidecar (covers registered worktrees too — this is what fixes a lingering `<name>.next.sock` with no live process). **Live + sidecar** → kill the recorded process group (SIGTERM → grace → SIGKILL, ESRCH-tolerant), then remove. **Live + no sidecar** (legacy backend) → log loudly and leave it.

This boot reconcile is the authoritative path and must stay before the watcher/sweep/eager-central goroutines in `main.go` (the "zero backends yet" invariant). It is **boot-only** — a periodic reconcile would risk killing the gateway's own live backends and is unnecessary, since intra-generation teardown is handled by `drainAndStop`/`Stop`.

The backend's own ppid-poll escape hatch (`server-core/bin/index.ts` — self-exit when reparented to PID 1) is kept as complementary defense-in-depth: it reaps the one case the dir-scan reconcile cannot see — a live backend whose socket file was already unlinked by a later cold-start — and orphans left while the gateway stays down.

## Path-length limit

macOS `sun_path` is 104 bytes. With the standard prefix (`/Users/<user>/.equin/sockets/`) and `.next.sock` suffix (the longer of the two per-worktree sockets), worktree names up to ~62 chars fit. If a worktree's name produces an overlong path, `NewWorktree` returns an error and the worktree is rejected at registration. Rename or shorten the worktree to recover.

This ~62-char budget applies to the dev `~/.equin/sockets/` prefix. A packaged release stages its data root at a deep versioned path (`releases/<wt>/<comp>-<target>/<run-id>/data`) that would blow the cap, so `launch.ts` reroots the sockets dir to a short `/tmp` path via `EQUIN_SOCKETS_DIR` (the env override read by `-sockets-dir`'s default) — a deep release data root therefore does not constrain worktree names. The dev limit itself is unchanged.

## File permissions

`Bun.serve({ unix })` creates the socket with umask-derived default permissions (typically world-readable). On a single-user dev machine this is acceptable. If multi-user use becomes a requirement, this is the right place to revisit (Bun does not currently expose a `mode` option; see also `chmod`-after-bind, which is racy).

## Concurrency Model

Two levels of locking:

- `Registry.mu` (RWMutex) guards the worktree map. Held briefly for lookup/insert/delete. Never held during I/O
- `Worktree.mu` guards per-worktree state. For slow ops (spawn, stop): lock → snapshot → unlock → work → relock → commit

Concurrent cold-start callers share a single in-flight spawn via a `readyCh` channel — second caller blocks until the first finishes, then both proceed or both get the same error. Concurrent `Restart()` calls are serialized by a separate `restartMu`; `restartDone` lets `Stop()` wait for an in-flight restart without holding the main mutex.

## Design Docs

Full design rationale, state machine diagrams, edge cases, and implementation history in:

- [`research/2026-04-09-gateway-design.md`](../research/2026-04-09-gateway-design.md) — v1 (path-prefix, model B)
- [`research/2026-04-09-gateway-design-v2.md`](../research/2026-04-09-gateway-design-v2.md) — v2 (subdomain, model A, detailed edge cases)
- [`research/2026-04-09-gateway-design-v3.md`](../research/2026-04-09-gateway-design-v3.md) — v3 (simplified schema and flat layout)
