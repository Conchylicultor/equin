# Self-contained app release (Sonata as v0) — web + Tauri

> Status: vision plan. Splits into a linear chain of independent sub-tasks (F1 → F5).
> Category: `global` (touches cli, codegen, gateway, infra, packaging).

## Context

Today Singularity only runs as the multi-namespace agent-manager: every app is served through the Go gateway at `http://<worktree>.localhost:9000`, identity is derived from a git worktree, and there is no way to ship a single app to an end user. We want to **release an individual composed app as a self-contained product** — starting with **Sonata** (the music app), stripped of the agent-manager / self-improvement / studio chrome — and to be able to launch it **either as a web deployment or as a Tauri desktop binary**.

The clean-design framing: do not special-case Sonata. Build a **reusable release pipeline** — a named composition + a static run profile — that any app can be packaged through. Sonata is the first consumer and the v0 proof.

### Requirements (locked with the user)

1. **Keep the Go gateway in every profile** (dev, server-deploy, Tauri-sidecar). No parallel stack; gateway hot-swap is wanted for server version upgrades.
2. **Dev workflow unchanged.** An agent runs `./equin build --composition sonata` and the gateway serves the filtered app at `http://<worktree>.localhost:9000/` exactly like today. The self-contained composition is testable in the normal loop.
3. **Two run profiles, same artifacts.** *Dev*: identity from git, multi-namespace. *Release*: identity from a static spec, single fixed namespace. The only difference is **where identity comes from**.
4. **Drop the `central` runtime** (auth/secrets) from the v0 Sonata closure — single-user local app.
5. **Keep Postgres** (Sonata persists songs). A no-DB mode is out of scope.
6. **API/closure-hardening** (a structural guard that app plugins can't pull agent/worktree infra) is filed separately (`task-1781819855397-cgtt9g`), not part of v0.

## Key architectural findings (these shaped the plan)

- **Namespace identity is already decoupled from git at runtime.** The backend never calls `git`. The gateway derives `SINGULARITY_WORKTREE=<spec-dir-basename>` (`gateway/worktree.go:584`) and every identity consumer reads that one env var — DB name (`plugins/database/server/internal/client.ts:7`), config dir (`plugins/config_v2/server/internal/config-dir.ts:4`), reports/profiling. **F2 is therefore tiny**: write a `spec.json` whose dir basename is the fixed namespace, without running `build.ts`.
- **`central` is the existing precedent for static, non-git registration.** Its spec is written with a hardcoded `server` path (`build.ts:739`) and the gateway picks it up via the same fsnotify watcher; it is sweep-exempt by name. F2 generalizes exactly this.
- **Migrations already run on boot**, unconditionally (database plugin `onReadyBlocking`, server bin). The build-time `drizzle-kit generate` only *authors* DDL — it is not an apply step. **F7 collapses** to a data-dir-location decision.
- **Dropping `central` is clean.** `CentralRoutes.Match` returns `""` when the manifest is absent (`gateway/central_routes.go:66`), falling through to subdomain routing. A release that never writes `central-routes.json` has no dangling `/api/auth/*` forwards.
- **Sonata's closure is clean.** Zero hard-deps on conversations/tasks/agent-manager/git/auth/central/secrets; tables are song-keyed (no `user_id`). Needs: `database`, `endpoints`, `attachments`, `entity-extensions`, `asset-mirror`, `config_v2`, `fields/*`, `live-state`, `pane`, `slot-render`, `data-view`, `apps`; plus `file-watcher`+`jobs` only for the `midi/folders` sub-plugin.
- **`start.ts` is ~80% of the launcher** (F3): it builds the gateway, synthesizes `database.json` for embedded PG + PgBouncer, supervises and daemonizes. Its only gap is that it assumes a prior `./equin build` produced the spec + dist.

## The run-profile model

Identity is a single resolved value `{ name, server, web }` produced by one of two providers and consumed identically downstream (gateway → `SINGULARITY_WORKTREE` env). **There is no backend code path to fork.** The shared primitive is a **spec-writer**:

- **Dev provider** = `build.ts` tail (`:1015`): `name = basename(getWorktreeRoot())`, server/web = this worktree's tree.
- **Release provider** = static writer (generalized `central`): `name = "sonata"` (fixed), server/web = the packaged tree. No git.

Extract the spec-writing tail of `build.ts` into `writeWorktreeSpec({name,server,web})` in `infra/worktree/server`; both dev and the release launcher call it. **One caveat — a second axis rides alongside identity:** DB *provisioning*. Dev forks the `singularity` DB (conversation-coupled); the release must instead **create-empty-then-migrate** (the boot migrator does the rest). This is the one real branch in F3.

## Registry filtering design (the crux of F1)

Filtering the committed `*.generated.ts` files would dirty the dev tree and break `plugins-registry-in-sync`, and would make "filtered" a tree state rather than a build input — fatal for requirement 2. Instead:

- Emit filtered registries to **gitignored sibling files** `<ownerDir>/core/<dir>.composition.generated.ts` (gitignore `*.composition.generated.ts`). Content = `renderCollectedDirRegistry` output intersected with the composition `bundle`.
- The two composition roots choose full-vs-filtered at the **import seam**:
  - **Web** (`App.tsx:11`): import a `@composition-web-registry` alias; `vite.config.ts` resolves it to the filtered file when `VITE_COMPOSITION` is set, else the full `web.generated`. **Must be a build-time `resolve.alias` branch, not a runtime `import.meta.env` ternary** — otherwise Rollup bundles both registries and ships all ~540 plugins anyway (silent failure mode).
  - **Server** (`server-core/bin/index.ts:12`): a `plugins-active` selector dynamically imports the filtered file when `SINGULARITY_COMPOSITION` is set, else `../core/server.generated`.

The committed full registries are never touched → `plugins-registry-in-sync` stays green and a normal `./equin build` is unchanged.

`bundle` comes from `resolveComposition(tree, flattenManifest(manifestItemToManifest(item), all)).bundle` (a `Set<PluginId>`), with the `sonata` manifest seeded in `plugins/plugin-meta/plugins/composition/core/config.ts`.

---

## Task chain (linear: F1 → F2 → F3 → F4 → F5)

Hard dependencies: F4/F5 need a self-contained boot (F3); F3 needs a filtered bundle (F1) **and** a static identity (F2). F1 and F2 are mutually independent — F1 goes first (highest uncertainty/reuse, fully testable in the dev loop), F2 second (small, only realized once F3 boots it). **F6 is absorbed into F1** (the filtered shell has no agent chrome because those plugins aren't bundled; only the root-route default remains). **F7 is absorbed into F3/F5** (migrate-on-boot already exists; only a data-dir decision remains).

### F1 — Composition build-gating (+ release-shell default)
**Scope.** `./equin build --composition <name>` resolves the composition `bundle`, emits gitignored `*.composition.generated.ts` filtered registries beside the full ones, and routes the two roots through env-selected selectors (web via a `vite.config.ts` alias branch on `VITE_COMPOSITION`; server via `SINGULARITY_COMPOSITION`). Add the Sonata-at-`/` release root default.
**Seams.** `plugins/framework/plugins/cli/bin/commands/build.ts` (new `--composition` option; filter after `regenerateRegistryCodegen`), `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (`renderCollectedDirRegistry` reused with a bundle intersection), `App.tsx:11` + `server-core/bin/index.ts:12` (repoint to selectors), `vite.config.ts` (alias branch), `.gitignore`, seed `sonata` manifest in composition `config.ts`.
**Done when.** `./equin build --composition sonata` then loading `<wt>.localhost:9000` shows only Sonata; the served `webEntries`/`serverEntries` equal `bundle`; a normal `./equin build` is unchanged and `plugins-registry-in-sync` stays green with a clean git tree.

### F2 — Static-spec identity (generalize `central`)
**Scope.** Factor `writeWorktreeSpec({name,server,web})` out of `build.ts` into `infra/worktree/server`; prove a packaged-style spec (fixed `name`, no git) boots and serves through the unchanged gateway env path.
**Seams.** `build.ts:1012–1025` (extract), `plugins/infra/plugins/worktree/server` (new writer), gateway unchanged.
**Done when.** Writing `~/.singularity/worktrees/sonata/spec.json` by hand (server+web → a built tree) makes `sonata.localhost:9000` serve Sonata with DB `sonata`, no git operation involved.

### F3 — Self-contained launcher/supervisor (+ data-dir, DB provisioning)
**Scope.** A `release`-mode boot that does what `start.ts` does (locate/build gateway, synthesize `database.json` for embedded PG + PgBouncer, supervise, daemonize) **plus** writes the static Sonata spec (F2) and ensures the DB exists via **create-empty-then-migrate** (not the conversation fork). Pick a release-specific data root (`SINGULARITY_DIR`/`PG_DIR`) **and** distinct ports/socket dir so a packaged install never collides with a dev install.
**Seams.** New launcher reusing `start.ts` helpers (`ensureDatabaseConfig`, service shapes), `plugins/infra/plugins/paths` (release data-dir override), `build.ts` DB-readiness logic adapted to create-if-absent.
**Done when.** On a machine with no worktree and no `./equin build`, the launcher brings up PG + gateway, registers the spec, migrations apply, and Sonata serves from an isolated data dir.

### F4 — Web release target
**Scope.** `./equin release --composition sonata --target web` → a deployable bundle (filtered dist + packaged `server-core` + the F3 launcher), gateway retained for hot-swap. Define the upgrade choreography: swap files → rewrite spec → `POST /gateway/worktrees/sonata/restart` → gateway gates on `/api/health/ready`.
**Seams.** New `release.ts` CLI command composing F1's filtered build + F3's launcher into a portable layout; ensure embedded PG/PgBouncer binaries are vendored into the probed bundle paths.
**Done when.** The emitted bundle, unpacked on a fresh host, serves Sonata via its bundled launcher; an in-place server upgrade hot-swaps without dropping the page.

### F5 — Tauri release target
**Scope.** `--target tauri` → Rust shell spawns gateway + PG as sidecars, webview loads `dist`, data in the OS app-data dir. Resolve single-origin routing and offline audio (below).
**Seams.** New Rust/Tauri shell; reuses F4's bundle + F3's launcher; `infra/paths` app-data override; gateway default-namespace routing (see risks).
**Done when.** The Tauri app launches (offline-after-warmup), persists songs across restarts, and a gateway sidecar swap works.

---

## Risks / open sub-decisions

- **Single-origin routing in the Tauri webview (sharpest risk).** A webview at bare `localhost`/`tauri://` has no `.localhost` subdomain; `parseWorktree` returns `""` (`gateway/proxy.go:338`) → 404. **Recommended fix: add a gateway "default namespace" config** so bare-localhost routes to the configured single app. This is a small Go change, fixes Windows (which doesn't resolve `*.localhost`), and is also the cleanest way to serve Sonata at bare `localhost:9000` in the web target — **consider pulling it forward into F2/F4**.
- **asset-mirror cold-start = silent broken audio offline.** Sonata's piano/soundfont samples fail 502 on a cold cache miss and the client degrades silently. A freshly installed Tauri app launched offline has no audio. **Mitigation: pre-seed the mirror cache into the bundle** (or first-run warm-up). Product-correctness issue for F5, not an edge case.
- **PG data-dir / port collision (5433 / 6432) between dev and packaged installs.** Release must use a distinct data root and ports (PG is socket-only, so distinct socket dirs largely suffice, but `database.json` still writes ports — pick release-specific values). Load-bearing deliverable of F3.
- **Port 9000 is hardcoded** in `main.go:34` and every TS probe URL. A packaged install coexisting with a dev gateway collides. Release picks a different port and threads it through the launcher probes — scope into F3.
- **Embedded PG/PgBouncer binary gating.** `start.ts` chooses embedded vs system PG by `existsSync` on the npm package dirs; if absent it silently falls back to `system` @ `localhost:5432`. F4/F5 packaging must vendor the binaries into the probed bundle layout.
- **Hot-swap upgrade flow has no precedent.** `build.ts`'s restart assumes in-place rebuild. F4/F5 must define the swap-files → rewrite-spec → restart → readiness-gate choreography explicitly (reusing the existing readiness-gated `/restart`).

## Verification (end to end)

1. **F1, in the dev loop:** `./equin build --composition sonata`; open `http://<wt>.localhost:9000` — only Sonata, no agent chrome; confirm the served registry equals `bundle`; confirm `./equin check plugins-registry-in-sync` green and `git status` clean.
2. **F2:** hand-write a static `sonata` spec; confirm `http://sonata.localhost:9000` serves with DB `sonata`, no git.
3. **F3:** on a clean dir (no worktree, no build), run the launcher; confirm PG+gateway up, migrations applied, Sonata served, isolated data dir/ports.
4. **F4:** unpack the web bundle on a fresh host; confirm serve + in-place hot-swap upgrade.
5. **F5:** launch the Tauri app offline; confirm UI loads, audio works (pre-seeded mirror), songs persist across restart.

## Critical files

- `plugins/framework/plugins/cli/bin/commands/build.ts` — composition flag, filtered emit, spec-writer extraction
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — `renderCollectedDirRegistry` reuse + bundle intersection
- `plugins/framework/plugins/web-core/web/App.tsx:11` + `plugins/framework/plugins/server-core/bin/index.ts:12` — registry import seams
- `plugins/framework/plugins/web-core/vite.config.ts` — build-time alias branch
- `plugins/framework/plugins/cli/bin/commands/start.ts` — launcher/supervisor precedent (F3)
- `plugins/plugin-meta/plugins/closure/core/resolve-composition.ts` + `plugins/plugin-meta/plugins/composition/core/config.ts` — `bundle` + `sonata` manifest
- `gateway/proxy.go` (default-namespace routing, F5) + `gateway/worktree.go:584` (`SINGULARITY_WORKTREE` identity channel)
