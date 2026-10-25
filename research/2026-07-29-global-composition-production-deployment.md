# Production deployment of a composition — the repo-defined host

> Status: plan — awaiting approval. Category `global` (cli, release, gateway, deploy app, infra/ssh, database/embedded).
> Parents: [`2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md) (F4),
> [`2026-06-20-global-web-release-target.md`](./2026-06-20-global-web-release-target.md),
> [`2026-07-10-global-website-release-composition.md`](./2026-07-10-global-website-release-composition.md) (§Follow-ups: "Public hosting"),
> [`2026-05-05-global-deploy-platform.md`](./2026-05-05-global-deploy-platform.md) (the Deploy app skeleton),
> supersedes the hand-written runbook shape of [`2026-05-04-global-equin-ai-deployment-roadmap.md`](./2026-05-04-global-equin-ai-deployment-roadmap.md) steps 1–2 and 5.

## Context

`./equin release --composition website --target web` already emits a genuinely
self-contained artifact (F4): one binary that self-extracts and brings up gateway +
embedded Postgres + the filtered backend on a fresh host with no bun, no Go, no
`node_modules`. That artifact was carried by hand onto a Hetzner box
(49.13.197.105, Ubuntu 24.04, 4-core/8GB) and it serves. Nothing about that is a
deployment:

- It answers on `http://49.13.197.105:9100` — **no TLS, no firewall**. The box has no
  `ufw` rules and the gateway binds `*:9100`.
- It runs under `nohup` as a hand-created `equin` user. **A reboot loses it.** Nothing
  supervises it, nothing restarts it.
- Postgres refuses to run as root (`initdb: cannot be run as root`), so the run-as user
  is **load-bearing but undocumented and unenforced** — there is no guard for it
  anywhere in the repo.
- The gateway routes by subdomain (`<name>.localhost:<port>`). What answers on
  `equin.ai` was undecided.
- Nothing addresses backups, log rotation, resource limits, upgrade, secrets, or drift.
- `/opt/singularity` on that box holds a full source checkout + `node_modules` + bun + go
  (~4GB) **only because the release pipeline is host-platform-bound and cannot cross-build.**

The question this plan answers: *what does a production deployment of a composition
actually consist of, and what must exist in the repo to make it reproducible?* The test
of the answer is destructive: **delete the box, provision a bare Ubuntu image, and get
back to a serving `equin.ai` with no human typing anything into an SSH session.**

### Decisions locked with the user

1. **Caddy terminates TLS in front; the gateway stays plain HTTP on loopback.**
2. **Cross-build from macOS.** A production host must never hold build inputs.
3. **A deployment is a Deploy-app DB record, not repo state** — `(composition × server)
   → { hostnames, loopbackPort }`. The same composition can be served on many surfaces,
   and **a URL is a deploy/server concern**, so this plan adds nothing to git.
4. **Ops scope for this plan is supervision + firewall + run user.** Backups, remote
   monitoring/drift detection, retention, and secret provisioning are follow-ups
   (§Out of scope).
5. **Resource limits are out.** `MemoryMax`/`CPUQuota` were in an earlier draft and are
   dropped — see §Out of scope for why the modelling question is genuinely open.

Decision 3 arrived by elimination across two rejected drafts, and the reasoning is the
substantive design content of this plan — see §Why there is no new abstraction in git.

### Two deliberate expansions beyond that scope

Both are cheap, and both close a hole that only exists *because* of what this plan builds.
Scoping either back out is your call.

- **A health gate on ship (D4.5)** that reverts `current` and restarts on failure. This is
  not the deferred "atomic upgrade + rollback" item (versioned history, retention, a
  manual rollback UI — all still follow-ups); it is the minimum that stops `ship` from
  being able to leave production down. A deploy command whose failure mode is "the site is
  now broken and stays broken" is not shippable. It is ~15 lines, plus `runId` on the
  health payload, and it is why the flip is a symlink rather than an overwrite.
- **The public-exposure guard at converge (D3)**, moved in from the follow-up list.
  Converge *is* the act of making a composition internet-reachable, so a plan that adds
  that capability and defers the guard ships a window where `converge agent-manager` puts
  conversations, tasks and secrets on the open internet with no auth. The machinery
  (`excludes` + `composition-closure`) already exists; this is a refusal over data that is
  already there.

## What a production deployment IS

Four artifacts, each with exactly one home. This is the whole answer; D1–D5 build it.

| # | Artifact | Lives in | Why there |
|---|---|---|---|
| 1 | **The composition** — what code is in the app | the repo, `compositions` config | *Already exists, and needs no new field.* This plan adds nothing to git. |
| 2 | **The bundle** — one platform-specific self-extracting binary + its `RELEASE.json` | `~/.singularity/releases/…/<run-id>/`, shipped to the host | Already exists (F4). D1 makes it buildable for a foreign platform. |
| 3 | **The server** — address, SSH port, login user, key | `deploy_servers` row + the `deploy-ssh` secrets namespace | A fact about the world. The key must *never* be repo state. |
| 3b | **The server's observed platform** | `deploy_servers_ext_health` (the probe's own side-table) | **Discovered**, not declared — so it belongs with the probe's other verdicts, not in the registry. See D2a. |
| 4 | **The deployment** — `(composition × server) → { hostnames, loopbackPort }` | `deploy_deployments` row (Deploy app) | *Where a composition is served and under what URL.* A deploy/server concern, not a property of the software. |
| — | **The converged host state** — run user, dir layout, systemd unit, Caddy site, firewall | **derived**, written by an idempotent step from 3–4 | Never authored on the box. Re-running converge is the only way it changes. |

The two verbs over a deployment are **converge** (make the host serve it) and **ship**
(put a bundle on it and activate). Both are re-runnable; neither reads anything that
isn't in 1–4.

### Why there is no new abstraction in git

A deployment is `(composition, server) → { hostnames, loopbackPort }` — and every field
of it is an *operational placement* fact, not a property of the software:

| field | belongs to the software? | home |
|---|---|---|
| `composition` | it **is** the software | existing `compositions` config (git) |
| `hostnames` | no — the same composition can be served at many URLs on many surfaces | deployment (DB) |
| `loopbackPort` | no — a property of the box it lands on | deployment (DB) |
| `platform` | no — the next box could be arm64 | the server's health probe, **discovered** |
| `runUser` | no, and it is never a *choice* | **derived — no field at all** |

Two earlier drafts of this plan got this wrong and are worth recording so the mistake is
not re-made:

- The first put `platform`, `port`, `runUser` and resource limits in a git-side spec.
  `platform` is the clearest tell — if it lived in git, **moving from an x86 box to an ARM
  box would be a code change and a commit**, for a fact about hardware you bought. It is
  therefore *discovered*: the health probe already SSHes in and runs `["true"]` as a no-op
  reachability check; making that `uname -sm` yields the platform as a byproduct of a probe
  that already runs.
- The second kept a two-field `deployments` config in git (`composition` + `hostnames`)
  plus an `exposure` enum. `exposure` was speculative — with a public cert and 443 open,
  the thing simply *is* public, so the future guard should read `hostnames.length > 0`
  rather than a flag a human can typo. And with it gone, the record was `{composition,
  hostnames}` — which is not a new abstraction at all, it is a **URL, and a URL is a
  deploy/server concern.**

`runUser` is deleted rather than relocated. Its only real requirement is *not root*
(because `initdb` refuses root), and a configurable field with a default is a field
someone can set to `root`. Converge derives `svc-<composition>`, so "never root" becomes
inexpressible rather than merely defaulted — the same move as the uid-0 guard, not a
second place to get it right.

**The tradeoff, stated plainly:** *which* composition is served at *which* URL is now DB
state, not git state — so it is not reviewable in a diff, and it is lost with the dev
machine's database (which the existing `backup` plugin covers). What remains fully
reproducible is everything the original complaint was about: the **host** is derived from
code, and the **artifact** is built from a commit. Inventory of URLs joins the server
list, which was already DB-only — one world, not two.

### One name, end to end

Because the deployment carries no id of its own, the **composition name is the only
identity below the URL**:

```
equin.ai                     ← hostname          (Caddy — many per deployment)
equin@website.service        ← install           (systemd)
/srv/equin/website/
  └─ data/  = SINGULARITY_DIR                    (isolation boundary)
       │
       ▼   gateway  -default-namespace website
     backend  SINGULARITY_WORKTREE=website       ← namespace (runtime identity)
       ├─ database "website"
       └─ config/website/
```

`launch.ts:105` (`const name = manifest.composition`) already makes the runtime namespace
the composition name, so naming the install and unit after it too means there is exactly
one name to reason about instead of an id that shadows it.

The cost is a **unique constraint on `(compositionId, serverId)`** — one deployment of a
given composition per server. Staging and prod of the same composition therefore live on
different servers, which is the normal arrangement anyway. If a second install on one box
is ever needed, add a `slot` discriminator to the key then; doing it now would reintroduce
the second id for no present requirement.

### The host layout converge produces

```
/srv/equin/<composition>/
  releases/<run-id>/<comp>-web-<platform>   the shipped binary (immutable once written)
  releases/<run-id>/app -> <comp>-web-…     fixed-name entrypoint (see below)
  current -> releases/<run-id>              the activation pointer — flipping this IS the deploy
  runtime/                                  EQUIN_RELEASE_DIR: the self-extract cache
  data/                                     SINGULARITY_DIR: postgres cluster, config, logs
  env                                       EnvironmentFile, 0600, root:svc-<composition>
```

```ini
# /etc/systemd/system/equin@.service   (templated: equin@website.service)
[Service]
User=svc-%i                  # derived from the composition name — this is what makes initdb legal
ExecStart=/srv/equin/%i/current/app
EnvironmentFile=/srv/equin/%i/env
Environment=SINGULARITY_DIR=/srv/equin/%i/data
Environment=EQUIN_RELEASE_DIR=/srv/equin/%i/runtime
Restart=always
PrivateTmp=yes
```

**One template file serves every composition, so nothing per-instance may appear in
it** — `%i` is the only variable systemd expands. Two values in an earlier draft
violated that and are relocated:

- **The binary name.** The shipped file is `${composition}-${target}-${platform}`
  (`packStagedTree`, `release.ts:1090`), which `%i` cannot reconstruct — it carries the
  platform. So **ship writes a fixed-name `app` symlink** beside the binary inside the
  release dir, and the unit execs that. The symlink is per-release (created at upload,
  before the `current` flip), so it is as immutable as the binary it names.
- **`SINGULARITY_LISTEN`.** Per-*deployment*, not per-composition. It goes in the `env`
  EnvironmentFile converge already writes, which is the file that exists precisely to
  carry per-install values.

### The listen address has exactly one authority

`launch.ts:107` already honours a `PORT` env override on top of the port baked into
`RELEASE.json` (`manifest.port`). Adding `SINGULARITY_LISTEN` beside it would make
**four** places a port is expressed — manifest, `PORT`, `SINGULARITY_LISTEN`, and the
deployment row. So:

- `SINGULARITY_LISTEN` (`host:port`) becomes the single runtime override and **`PORT` is
  retired** — it is a strictly weaker form of the same knob (no bind host), and the whole
  point of the bind host is that it cannot be forgotten.
- `manifest.port` stays as the **default when nothing is set**, which is what makes a
  bundle runnable by double-click with no environment at all.
- `deployment.loopbackPort` is the only *authored* value; converge renders it into `env`.

`release --port` therefore has no effect on a deployed install. That is correct — a build
input should not decide a placement fact — but it is worth stating so nobody sets it
expecting it to.

Three things fall out of that unit for free, which is why it is the right primitive
rather than a wrapper script:

- **Reboot survival + crash restart** — `Restart=always`, `WantedBy=multi-user.target`.
- **Log rotation** — stdout/stderr go to journald, which rotates and caps by itself.
  No logrotate config to write, no `nohup.out` to grow unbounded.
- **The run user is enforced, not documented** — `User=` makes the privilege drop
  structural. `initdb` can no longer see root because systemd never gives it root.

`EQUIN_RELEASE_DIR` is set explicitly because `PrivateTmp=yes` gives the service its own
`/tmp`; without it the self-extractor would re-extract the whole bundle on every boot
(it falls back to `tmpdir()` — `release.ts:1052`).

### Why Caddy in front is nearly free

The gateway already has everything needed. `-default-namespace`
(`gateway/main.go:70`, `proxy.go:62`) was built for the Tauri bare-`localhost` case, and
the release launcher already passes it (`spawnGatewayDaemon({ defaultNamespace })`). So:

```
equin.ai:443 ──TLS──▶ Caddy ──▶ 127.0.0.1:9100 ──▶ gateway (-default-namespace website)
```

`parseWorktree("equin.ai")` returns `""` (`proxy.go:446` — anything not ending in
`.localhost` yields no worktree), which falls straight through to the default namespace.
**Zero gateway routing change.** A second composition on the same host needs only a
second Caddy site block with `header_up Host <comp>.localhost`. Caddy handles ACME,
renewal, and WebSocket upgrades (`/ws/*`) natively.

The one gateway-adjacent change is the **bind address**: `spawnGatewayDaemon` hardcodes
`-listen :${port}` (`boot.ts:375`), a wildcard bind. Threading a bind host through makes
the public-port hole structurally impossible — the gateway becomes unreachable off-box
even if the firewall is misconfigured. The `-listen` flag itself already accepts
`host:port`, so this is a TS-side change only.

---

## D1 — Cross-platform release (`--platform`)

**The enabling change.** Every later phase is forced to keep a toolchain on production
until this exists, and "prod holds build inputs" is the thing we are removing.

`./equin release --composition website --target web --platform linux-x64`,
executed from macOS arm64.

`platformTag()` (`release.ts:109`) is the single choke point — it derives from
`process.platform`/`process.arch` with no override, and everything platform-bound reads
it. Make it a resolved parameter (default: host) threaded through the four consumers:

- **Compiled entrypoints** — `compile()` (`release.ts:300`) gains the Bun target
  (`bun-linux-x64`). Bun cross-compilation is first-class and downloads the target
  runtime itself (`--compile-executable-path` is the offline/pinned fallback). The
  `bun-` prefix is **mandatory** — `Bun.Build.CompileTarget` is `` `bun-linux-${Architecture}` ``,
  and the JSDoc example in `bun.d.ts:2998` showing `target: 'linux-x64'` is wrong and
  does not typecheck. `bun-linux-x64` resolves to the glibc/AVX2 build, consistent with
  the embedded-PG `linux-x64` (glibc) and `@parcel/watcher-linux-x64-glibc` choices; use
  `bun-linux-x64-baseline` if pre-AVX2 hosts ever matter. Affects `server`, `launch`,
  `pg-start`, `pgbouncer-start`.
- **Gateway** — `go build` (`release.ts:600`) gains `GOOS`/`GOARCH` via `run()`'s existing
  `env` option (which already merges over `process.env`, so `PATH` survives). The gateway
  is *not* cgo-free — `gateway/sigterm_darwin.go:39` has an `import "C"` sigaction shim —
  but it sits behind `//go:build darwin` with a `sigterm_other.go` twin (same split for
  `loadavg_*.go`), so it is excluded under `GOOS=linux`.
  **`CGO_ENABLED` is a function of the target OS, not a blanket `0`** (an earlier draft
  said `0` flat, which is wrong): the twin's tag is `//go:build !darwin`, so a *darwin*
  target with cgo off compiles **neither** file and fails on `undefined:
  logSigtermSender`. Go also defaults cgo off whenever `GOOS`/`GOARCH` differ from the
  host, so darwin-arm64 → darwin-x64 must set it explicitly **on**. It is therefore `0`
  for linux targets (a static binary beholden to no host glibc version) and `1` for
  darwin.
  **Also change `-o`:** today it writes `<repo>/gateway/gateway` and then `cpSync`s it.
  A cross-build would leave a *linux* binary at the path `buildOrLocateGateway`
  (`boot.ts:316`) short-circuits on — so a later `./equin start` would silently
  launch a linux gateway on the Mac. Emit straight to `<out>/gateway/gateway` and drop
  the copy.
- **Vendored natives** — `embeddedNativeDir()`, `pgbouncerNativeBin()`,
  `parcelWatcherNativeNode()` (`release.ts:363-418`) resolve `@embedded-postgres/<tag>`,
  `@equin/pgbouncer-<tag>`, `@parcel/watcher-<tag>[-glibc]` out of the repo's
  `node_modules`. These are `os`/`cpu`-gated `optionalDependencies`, so only
  `darwin-arm64` is on disk. All three targets are already pinned with integrity in
  `bun.lock`, and bun 1.3.13 has `--os` / `--cpu` install overrides — so the fetch is:
  **`mkdtemp` a staging dir, write a `package.json` listing the three at their pinned
  versions, `bun install --os=linux --cpu=x64` there**, and point the helpers at
  `<staging>/node_modules/...` by direct `join` (drop `Bun.resolveSync` — the target
  package is not in the host's resolution graph). Cache the staging dir on
  `<tag>+versions`.
  Two hard constraints: **never run the override install in the repo root** (it prunes
  the host's `darwin-arm64` natives out of the shared `node_modules` and breaks the dev
  cluster), and **sequence it after phase 1** — `build-composition` runs a plain
  `bun install` (`internal/app-artifacts.ts:319`) that would re-prune anything staged
  earlier.
- **Self-extractor** — `packStagedTree()` (`release.ts:1090`) shells
  `bun build --compile`, so it takes the CLI flag form `--target=bun-linux-x64`. This is
  the *shipped* binary; without the flag you produce a Mach-O self-extractor wrapping a
  linux payload. The embedded tarball itself is platform-agnostic, with one nit: macOS
  bsdtar writes `SCHILY.xattr.com.apple.provenance` pax headers, which perturb the
  sha256 that keys the extraction cache dir (`release.ts:1027`). Append
  `--no-xattrs --no-mac-metadata` (both — neither alone strips it) when building on
  darwin.

Two host-conditional branches must key off the **target**, not the host:
`release.ts:401` `process.platform === "linux"` (selects the `-glibc` parcel-watcher
suffix — the subtlest bug of the set: on a Mac host it silently picks the nonexistent
`@parcel/watcher-linux-x64` and throws a misleading "run `bun install`") becomes
`tag.startsWith("linux")`. `release.ts:843` is the darwin/dmg branch, unreachable for
`--target web`. **`--target tauri` must explicitly reject a non-host `--platform`** — a
Rust/webkit2gtk sysroot, `xcrun` and `appdmg` are genuinely not cross-buildable.

Nothing here is a blocker — the whole inventory is 12 sites, 11 of which are one-line
parameterizations and one of which is the staged native fetch above. The runtime side is
already clean: every darwin-specific path in the shipped closure is a *runtime*
`process.platform` read executing on the target (`phys-footprint.ts:75`,
`host-admission/pool.ts:19`, `spawn-priority/background.ts:24`, the health/paging
samplers), the two start scripts' `platformPackage()` is dead code under the
`SINGULARITY_PG_BIN_DIR` / `SINGULARITY_PGBOUNCER_BIN` overrides the release already
sets, and the embedded-PG symlinking is driven by a `pg-symlinks.json` manifest shipped
*inside* each platform package (`embedded/scripts/start.ts:66-87`) — OS-neutral, and
load-bearing, so it must survive the `cpSync`. `boot.ts:583`'s `lsof` dependency is
reachable only from `teardownSelfContainedApp`, whose entry is compiled for `tauri`
only.

**The one thing lost:** you cannot smoke-test the artifact on the build host — a Mac
cannot exec linux binaries, so `--dev` staging is unverifiable locally and D1's proof
requires a container.

**Both D1 risks are now resolved — the cross-build was run for real** (`--composition
website --target web --platform linux-x64`, from darwin-arm64, 2026-07-29):

| artifact | result |
|---|---|
| `RELEASE.json.platform` | `linux-x64` |
| `dist/website-web-linux-x64` | ELF 64-bit x86-64, dynamically linked (634 MB) |
| `gateway/gateway` | ELF x86-64, **statically linked** — `CGO_ENABLED=0` on the linux target worked |
| `pgbouncer/native/bin/pgbouncer` | ELF x86-64, **statically linked** |
| `parcel-watcher/watcher.node` | ELF x86-64 shared object |
| `launch`, `server` | ELF x86-64 |
| `pg/native/` | `bin lib share pg-symlinks.json` — the load-bearing manifest survived the `cpSync` |
| `<repo>/gateway/gateway` | **absent** — the `-o` fix leaves no linux binary where `buildOrLocateGateway` would find it |

- The staged native fetch works: `bun install --os=linux --cpu=x64` resolves all three
  target packages from a Mac, and the `--target=bun-linux-x64` + `--no-xattrs
  --no-mac-metadata` flags all appear in the real command lines.
- **`@equin/pgbouncer-linux-x64` needs no extra apt packages — proven, not inferred.** It
  is *statically linked*, so converge installs no `libssl`/`libevent`. (An earlier pass
  inferred this from `strings`; the built artifact settles it.)

**What is still unproven: that any of it runs.** A Mac cannot exec an ELF binary and this
machine has no container runtime, so "the pipeline emits correct-format artifacts" is the
ceiling of local verification. Booting the bundle remains a container-or-box step.

One thing the same check surfaced, which is **not** a cross-build problem but is a
footgun: `@embedded-postgres/*` ships a `postinstall` (`hydrate-symlinks.js`) that bun
blocks, and neither the root nor the plugin `package.json` declares `trustedDependencies`
— so it is blocked for the *host* install too. Host and staged trees are therefore
symmetric, and the real mechanism is runtime hydration from the shipped manifest
(`embedded/scripts/start.ts`'s `ensureSymlinks`), which is why this works at all. But that
function opens with `if (!existsSync(manifestPath)) return;` — a silent no-op on a
load-bearing path. If the `cpSync` ever drops `pg-symlinks.json`, Postgres fails later
with a confusing missing-library error instead of naming the missing manifest. Fixed in
D3's pass over that file, alongside the uid-0 guard.

**Done when.** A `linux-x64` bundle built on macOS runs on a bare Ubuntu container
with no bun/go/node and serves the composition; `RELEASE.json.platform` reads
`linux-x64`; a plain `release` with no `--platform` is byte-identical to today.

## D2 — The deployment record (Deploy app only)

**Nothing in this phase touches git.** No new config, no new top-level plugin, no
`./equin check` addition. Two pieces, both inside the existing Deploy app.

### D2a — `platform` on the health probe, discovered not declared

Populate the platform from the **existing** health probe: `handle-check.ts:33` currently
runs `sshRun(target, ["true"])` as a deliberate no-op, so any non-zero exit is
unambiguously an SSH-layer failure. Change it to `["uname", "-sm"]` — a command that
cannot fail on a reachable POSIX host, so the failure-classification property is
preserved — and map the output (`Linux x86_64` → `linux-x64`) through the same
`PLATFORM_TAGS` list.

**The column goes in `serverHealth`, not `deploy_servers`.** The registry table records
its own rule in a comment and its wire schema repeats it: *"reachability is probe-written
state with a different writer and lifecycle, owned by the `health` sub-plugin's
`deploy_servers_ext_health` side-table. Keeping a `status` column here beside a probe that
owns the real verdict would be two sources of truth."* A discovered platform is exactly
that — probe-written, refreshed on every check, stamped as of that check — and the
side-table already holds its twin in `checkedPublicKey` ("`deploy_servers.ssh_public_key`
AS OF the check"). So it is a nullable `platform: text("platform")` added to the existing
`defineExtension(_deployServers, "health", …)` in
`plugins/apps/plugins/deploy/plugins/health/server/internal/tables.ts`, written by the
same upsert that already records the verdict. Nothing in `servers/` changes, and the
health plugin does not acquire a write into another plugin's table. Unlike `hostKeyLine`
(deliberately withheld from the wire), `platform` goes on `ServerHealthRowSchema` — the
UI has to show which artifact a server will accept.

That means the platform is refreshed on every reachability check and is **never typed by
a human**. A reinstalled or resized box reports its own truth.

**Never-probed is a real state.** `platform` is null until a check succeeds, so it is not
merely "unknown" — it means *we have never reached this box*. Both `converge` and `ship`
refuse with a named error (`"server <name> has never been verified — run Verify
connection first"`) rather than comparing against null. Per the absorbable-failure rule,
the null is turned into a refusal at the boundary, not carried into an assert.

`PLATFORM_TAGS` is the closed list D1 introduces — put it in `plugins/release/core/`
next to `RELEASE_TARGETS`, the exact precedent for "a closed set both runtimes need lives
as plain data in `core/`, not a slot".

### D2b — the deployment table

One small table in a new Deploy sub-plugin
(`plugins/apps/plugins/deploy/plugins/deployments/server/internal/tables.ts`):

```
deploy_deployments: id, compositionId (text), serverId (FK → deploy_servers, cascade),
                    hostnames (text[]), loopbackPort (int, default 9100),
                    createdAt, updatedAt
```

Two unique constraints carry the invariants, so neither needs a check:
`(compositionId, serverId)` — one install of a composition per server (see §One name,
end to end) — and `(serverId, loopbackPort)`, since the port is the only resource two
installs on one box contend for.

`compositionId` is validated against the `compositions` config **at write time** in the
create/update handler, not by a repo check — the row is runtime data, so a stale
composition name must fail loudly when someone saves it, not at the next build.

Everything else about the install is **derived, never stored**:
`runUser = svc-<compositionId>`, `installDir = /srv/equin/<compositionId>`,
`unit = equin@<compositionId>`, `platform = serverHealth(serverId).platform`.

Alongside: a `deploy.deployments` push resource (the `deploy.servers` resource in
`servers/server/internal/resources.ts` is the precedent to copy), and CRUD endpoints
following the same `defineEndpoint` + `implement` shape as the servers registry.

**Done when.** A deployment can be created against a registered server from the app; a
duplicate `(composition, server)` or a colliding port is rejected by the DB; a bogus
composition name is rejected by the handler; a "Verify connection" on a server fills in
its `platform` on the health row (and `deploy_servers` still has no probe-written column).

## D3 — Host convergence

New CLI command `./equin deploy converge <composition> --server <server-id>`
(creating the deployment row if absent), plus the `sshUpload` addition it needs.

**`sshUpload` in `plugins/infra/plugins/ssh/`** — a sibling of `sshRun`, sharing the
*same* isolation-flag argv builder (factor it out; the flags at `run.ts:66-110` are
security-critical and must not drift between the two). Implemented over `scp` rather
than `sshRun`'s stdin, because `spawnCaptured`'s stdin is a whole in-memory buffer
(`spawn/core/internal/types.ts:17`) and a bundle is ~100MB+. Same discriminated
`{ok:false, kind}` result, same TOFU-or-pinned host-key policy, same mkdtemp'd 0600 key.
Also raise the caller-supplied timeout — `sshRun`'s 15s default is a reachability
probe's budget, not a converge run's.

Converge is **one idempotent script generated from the deployment row** (not a checked-in
`bootstrap.sh` with hand-edited values), uploaded and executed as the server's *login*
user (`deploy_servers.sshUser`, root by default — converge needs root to create users and
write `/etc`). The *run* user is a different, unprivileged, derived one; that split is the
whole point. Writing `<c>` for the composition name:

1. `useradd --system --create-home svc-<c>` (skip if present). Derived from the
   composition name — never read from a field, so it can never be `root`.
2. `mkdir -p /srv/equin/<c>/{releases,runtime,data}`, owned `svc-<c>`.
3. Write `/srv/equin/<c>/env` (0600, `root:svc-<c>`) — see §What goes in `env` below.
4. Install Caddy (**not a bare `apt-get install caddy`** — see below), write
   `/etc/caddy/sites/<c>.caddy` from `hostnames` + `loopbackPort`, `caddy validate`,
   reload.
5. Write `/etc/systemd/system/equin@.service` (the template above), `daemon-reload`,
   `enable equin@<c>`.
6. `ufw default deny incoming`, `ufw allow 22,80,443/tcp`, `ufw --force enable` — in that
   order, so the SSH session converge is running over survives the enable.

**Two commands that do not work as first written**, and the acid test is "zero commands
typed into an SSH session", so converge has to be right the first time:

- **Caddy is not in Ubuntu 24.04's archives.** `apt-get install -y caddy` fails on a bare
  image. Converge must first install the official repo — fetch the signing key to
  `/usr/share/keyrings/caddy-stable-archive-keyring.gpg`, write the `deb [signed-by=…]`
  source list, `apt-get update` — then install. Idempotent because both writes are
  content-identical on re-run. (`ufw` *is* in the base image, but keep it in the install
  line; it is a no-op when present.)
- **`ufw allow 22,80,443` is rejected** — a multiport rule requires a protocol. It is
  `ufw allow 22,80,443/tcp`.

### What goes in `env`

This is the one step that writes secret material onto a host over SSH, so it gets an
explicit model rather than "from the secrets store":

- **The per-deployment values converge derives** — today exactly
  `SINGULARITY_LISTEN=127.0.0.1:<loopbackPort>`. These are not secret; they are here
  because the unit template cannot hold per-instance values.
- **Deploy secrets, each approved by the user for this deployment.** *(Amended
  2026-10-24 — `research/2026-10-24-global-website-contact-form.md` §1; the plugin is
  `apps/deploy/deploy-secrets`.)* A plugin that needs a credential on the box declares it
  in its `core/` with `defineDeploySecret({ key, description })`; the deploy side finds
  every declaration in the composition's closure through the `deploy-secrets` facet,
  never by name. The value is entered locally (the `deploy-secrets` namespace of the
  secrets store) and **approved per deployment**: a grant records an HMAC fingerprint of
  the value, so a rotated value is unapproved again. A run whose closure needs a secret
  that is missing, new or changed ends `needs-approval` before any leg spawns
  (`DeployGates`), and converge re-checks before touching the host. The approved
  `KEY=value` lines reach converge over the SSH session's **stdin** — never argv, never
  the uploaded script, never the transcript (keys only) — and are written into the
  0600 `root:svc-<c>` env file beside `SINGULARITY_LISTEN`; a key no longer required is
  simply not written, so removing a secret needs no approval. The box reads it with
  `readDeploySecret`, which answers `set` / `unset`.
- **The secrets STORE stays off the box, and that is enforced.** `infra/secrets` is
  hosted on the *central* runtime, which a released bundle has none of, so converge still
  **refuses a composition whose closure includes `infra/secrets`**: the local approval
  plugin that reads it is never in a deployed closure.

### The public-exposure guard is part of converge, not a follow-up

Converge is the moment a composition becomes reachable from the internet, so the refusal
belongs here — and it is cheap enough (`hostnames.length > 0` ∧ closure ∩ owner-data
bundles) that deferring it means shipping a window in which `converge agent-manager` puts
conversations, tasks and secrets on the open internet with no auth. Refuse when the
deployment has any hostname and the resolved closure intersects the owner-data plugins
(`agent-runtime`, `auth`, conversations / tasks / secrets), using the existing `excludes`
+ `composition-closure` resolution.

`exposure` is **derived, never declared**: a deployment with a public hostname behind an
open 443 simply *is* public, so there is no flag to typo. The
[single-instance-per-user ADR](./2026-07-02-global-adr-single-instance-per-user.md)
sanctions a single trusted principal on a loopback-only runtime; it never sanctioned a
composition on the open internet. Enforcing at converge rather than in
`./equin check` is also the more honest placement — hostnames are runtime data that
a repo check cannot see, and the guard fires when the exposure is actually created rather
than when unrelated code is compiled.

The only inputs are the deployment row's two fields and the composition name. Every step
is convergent: re-running changes nothing when the host already matches, and repairs it
when it drifted. The script is *generated*, so there is no file on the box a human is
expected to edit.

**Also in D3, two structural fixes to the run-as-root footgun** (per CLAUDE.md: remove
the footgun, don't memorize it):

- `plugins/database/plugins/embedded/scripts/start.ts` — fail loudly with a named error
  when `process.getuid?.() === 0`, before reaching `initdb`. Today the failure is
  Postgres's own message from deep inside a spawn; it should be ours, at the boundary,
  naming the run user.
- `spawnGatewayDaemon` (`boot.ts:354`) — take a bind address, not just a port, and have
  `launch.ts` read `SINGULARITY_LISTEN`, **retiring the existing `PORT` override**
  (`launch.ts:107`) in the same change rather than leaving two env knobs for one value.
  Default with neither set is unchanged (`:${manifest.port}`), so dev and desktop are
  untouched.

**Done when.** Converge run twice against a bare Ubuntu image is a no-op the second
time; `systemctl is-enabled equin@website` is `enabled`; `ufw status` shows only
22/80/443/tcp; the gateway (once shipped) is unreachable on `:9100` from off-box;
`converge` of a composition carrying owner data to a hostname is refused; `converge`
against a never-verified server is refused by name.

## D4 — Ship

`./equin deploy ship <composition> --server <server-id> [--release <run-id>]`.

1. Read the deployment row to get the server, then **take the platform from the server's
   health row** — never from a flag or the deployment; refuse if it is null (D2a). Resolve
   the bundle: `--release`, else the `latest` symlink for `<composition>-web` (the
   discovery contract in `plugins/release/CLAUDE.md`). **Assert
   `RELEASE.json.platform === serverHealth.platform`** — shipping a darwin artifact to
   Linux fails here, loudly, not at `systemctl start`. Because the platform is discovered
   rather than declared, this assert compares two observed facts; there is no third place
   for a human to have typed it wrong.
2. `sshUpload` the binary to `/srv/equin/<c>/releases/<run-id>/`, `chmod +x`, and create
   the fixed-name `app` symlink beside it (the unit's `ExecStart` — see §The host layout).
   Both happen before the flip, so `current` never points at a dir the unit cannot exec.
3. Flip `current` → the new `<run-id>` (symlink swap, atomic).
4. `systemctl restart equin@<c>`.
5. **Health gate**: poll `http://127.0.0.1:<loopbackPort>/api/health/ready` from the host,
   then confirm the served build reports the shipped `runId` (see below). On failure: flip
   `current` back, restart, and fail the command with the captured logs. Production is
   never left down by a bad ship.
6. **Prune the extraction cache.** The self-extractor keys its extract dir on the tarball
   hash (`release.ts:1027`) under `EQUIN_RELEASE_DIR`, so every ship leaves a full
   extracted bundle behind in `runtime/` forever. Remove the dirs whose hash is not the
   one `current` resolves to. This is not the deferred retention item (which is about
   keeping last-N `releases/<run-id>` for rollback) — it is a leak with no upside, and on
   a box nobody SSHes into, disk-fill is the failure mode that takes the site down
   silently.

**The `runId` check needs a surface that does not exist yet.** `/api/health` returns
`{ok, startedAt}` and `/api/health/ready` returns `{ready:true}` — neither names the
build. Add `runId` (and `composition`) to the health payload, read from the `RELEASE.json`
the launcher already parses at `launch.ts:104`, null outside a release. Without it the
gate can only prove *something* is up, which would let a failed `current` flip pass as a
success — the exact case the gate exists to catch.

The run ledger stays where it already is. Per the **Deploy handoff note** in
`plugins/release/CLAUDE.md` — *"add a remote transport over the same `_releaseRuns` table
+ `RELEASE_TARGETS` registry rather than forking the lifecycle — keep the run model here,
let Deploy own where the artifact lands"* — D4 introduces **no new run table**. It adds a
transport and records where a bundle landed; it does not re-implement release's
pid-claim/status/orphan-reconcile machinery.

**Done when.** `ship` onto a converged host serves the composition over TLS on its
hostname; `/api/health` reports the `runId` that was shipped; a deliberately-broken bundle
is rejected by the gate and the previous version is still serving afterwards; a second
ship leaves exactly one extracted bundle in `runtime/`.

## D5 — Deploy app UI

The CLI is the engine, the app drives it — the exact split `release` (CLI) / Studio
(UI) already uses. Contribute into the existing `Deploy.Section` slot on
`serverDetailPane` (`plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx`):

- A **Deployments** section listing this server's deployments (a `data-view`, per the
  DataView rule — these are homogeneous domain records, not chrome), with an add
  affordance whose composition picker reads the `compositions` config, plus **Converge**
  and **Ship** row actions.
- Live output streamed into a `Log.channel`, mirroring release's log streaming, surfaced
  through the same pane shape as the Studio release logs section.

All of this lives in the D2 sub-plugin `plugins/apps/plugins/deploy/plugins/deployments/`
(table + endpoints + resource + UI). It reads compositions through
`plugin-meta/composition/web`'s existing `useManifestItems()` rather than touching
`config_v2` directly — collection-consumer separation, and the same hook the Studio
compositions pane uses.

---

## Critical files

**Modify**
- `plugins/framework/plugins/cli/bin/commands/release.ts` — `--platform`; `platformTag()` → `resolvePlatformTag(opt?)` (the single seed, consumed at `:464`); `compile()` target (`:300`, 5 call sites); `go build` GOOS/GOARCH + `-o` into `<out>` (`:600`); the three native resolvers → staged target fetch (`:363-418`); `:401` host→target; `packStagedTree()` target + tar flags (`:1024`, `:1090`); reject cross-platform `tauri`.
- `plugins/release/server/internal/run-release.ts:194` — optional: surface `--platform` through `targetDef.buildArgs` if Studio should pick it. The ledger already carries it (`RELEASE.json` → `_releaseRuns.platform`) for free.
- `plugins/infra/plugins/launcher/server/internal/boot.ts:354,375` — `spawnGatewayDaemon` takes a bind address.
- `plugins/infra/plugins/launcher/bin/launch.ts:107` — read `SINGULARITY_LISTEN` (host:port); retire the `PORT` override in the same change so one knob replaces one knob.
- `plugins/database/plugins/embedded/scripts/start.ts` — loud uid-0 guard.
- `plugins/infra/plugins/ssh/server/internal/run.ts` — extract the shared isolation-argv builder.
- `plugins/infra/plugins/ssh/server/index.ts` — export `sshUpload`.
- `plugins/release/core/targets.ts` (sibling) — `PLATFORM_TAGS` closed list.
- `plugins/apps/plugins/deploy/plugins/health/server/internal/tables.ts` — nullable `platform` on the existing `serverHealth` extension. **Not** `deploy_servers` — probe-written state, per that table's own recorded rule (D2a).
- `plugins/apps/plugins/deploy/plugins/health/server/internal/handle-check.ts:33` — `["true"]` → `["uname","-sm"]`; parse and stamp `platform` in the same upsert that records the verdict.
- `plugins/infra/plugins/health/shared/protocol.ts` — add `runId` + `composition` (nullable outside a release) to `HealthResponseSchema`, so D4's gate can prove *which* build is serving.
- `plugins/infra/plugins/health/server/` — populate them from the launcher's already-parsed `RELEASE.json`.

**Create**
- `plugins/infra/plugins/ssh/server/internal/upload.ts` — `sshUpload`.
- `plugins/framework/plugins/cli/bin/commands/deploy.ts` — `converge` / `ship`.
- `plugins/apps/plugins/deploy/plugins/deployments/` — the `deploy_deployments` table, endpoints, push resource, and the UI section. **The only new plugin in the whole plan.**

**Regenerated by `./equin build` — never hand-edit**
- The migration for `deploy_deployments` + the `deploy_servers_ext_health.platform` column, the plugin registries, `docs/plugins-{compact,details}.md`.

## Verification

The acid test is destructive, and it is the only one that proves the claim:

1. `./equin build && ./equin check` — green, clean tree.
2. **D1 in isolation**: `./equin release --composition website --target web --platform linux-x64` on the Mac. The artifact cannot be exec'd locally, so run it in a bare `ubuntu:24.04` container (no bun/go/node); `bun plugins/release/e2e/release-boot-verify.ts --url http://localhost:9100/ --settle 15000` → PASS. Confirm `file <binary>` reports ELF x86-64, and that `<repo>/gateway/gateway` is still the host's darwin binary afterwards (the `-o` regression guard).
3. **Build the box from nothing — on a *second* box.** Provision a fresh Ubuntu 24.04
   alongside the existing one, register it in the Deploy app, `converge`, `ship`. Success
   = it serves over TLS on a staging hostname with **zero** commands typed into an SSH
   session. Steps 4–8 run against this box.
   *The old box is deleted only after step 8 passes and DNS is flipped.* The proof the
   plan owes is "a bare image becomes a serving host with no human in the SSH session" —
   which a second box demonstrates exactly as well, without an outage window in which the
   only way back up is the hand-typed runbook this plan exists to delete.
4. **Reboot the host** — the site comes back with no intervention (`Restart=always` + `enable`).
5. **`kill -9` the gateway** — systemd restarts it.
6. **Firewall + bind**: from off-box, `:9100` refuses; `:80` redirects to `:443`; `:443` serves. `ss -ltnp` on the host shows the gateway on `127.0.0.1` only.
7. **Idempotence**: `converge` twice — the second run reports no changes.
8. **Gate**: ship a deliberately-broken bundle — the command fails, and the previous version is still serving. Then ship a *working* bundle whose `runId` differs, and confirm the gate reads the new `runId` back from `/api/health` (proving the gate checks the build, not just liveness).
9. **Cut over**: flip `equin.ai` DNS to the new box, confirm it serves, then delete the old one.
10. **No build inputs**: `/opt/singularity` never existed on the new box and nothing creates it; the host has no bun, no go, no `node_modules`, no checkout.
11. **Guards fire**: `converge agent-manager` against a deployment with a hostname is refused (owner-data closure); `ship` against a server with no successful probe is refused by name.

## Out of scope — follow-ups (file with `add_task`, do not build here)

> The **public-exposure guard** was a follow-up in an earlier draft and has been **pulled
> into D3**. It is the one moment a composition becomes internet-reachable, the machinery
> (`excludes` + `composition-closure`) already exists, and deferring it ships a window in
> which `converge agent-manager` puts conversations, tasks and secrets on the open
> internet with no auth. See §The public-exposure guard is part of converge.

- ~~**Provisioning secrets to a deployed host.**~~ *Done 2026-10-24* — approved deploy
  secrets (`apps/deploy/deploy-secrets`, see §What goes in `env`): declared by the
  plugin that needs one, discovered in the closure, approved per deployment and per
  value, delivered over SSH stdin into the env file. `infra/secrets` itself stays
  refused in a deployed closure.
- **Backups.** A `pg_dump` systemd timer written by converge, shipping to an object-store
  target. The existing `plugins/backup` plugin is scoped to the *dev machine*
  (transcripts, Claude settings, project memory) — reuse its target registry concept,
  don't force its sources onto a prod host. Note this now also covers the deployment
  inventory itself, since that lives in the local DB (see §Why there is no new
  abstraction in git).
- **Drift + remote monitoring.** Extend the Deploy health probe from "SSH answers" to
  "the hostname serves over TLS and reports the release id we shipped", so a drifted or
  silently-dead deployment is visible in the app.
- **Retention + manual rollback.** Keep last N `releases/<run-id>` dirs, sweep older;
  a rollback action in the UI. (D4's gate-revert is not this; nor is D4.6's pruning of the
  `runtime/` extraction cache, which is a leak fix rather than a retention policy — the
  cache has no rollback value, so "keep only what `current` resolves to" needs no N.)
- **Resource limits** (`MemoryMax` / `CPUQuota` on the unit). Deliberately left out — the
  modelling question (is a limit the app's declared appetite, or a property of this
  deployment on this particular box's capacity?) is unresolved. The natural shape once
  decided: a column on the deployment row, with the server's discovered capacity as the
  ceiling and oversubscription rejected at write time.
- **A second install of one composition on one server.** Blocked today by the unique
  `(compositionId, serverId)` constraint, which buys the single-name property. Add a
  `slot` discriminator to the key if a real need appears.
- **Cross-build the `tauri` target** (D1 covers `web` only).
- **Multi-server / zero-downtime.** Blue-green across two hosts. Out of scope while the
  answer is one box; the `current` symlink is deliberately the seam that would grow into it.
