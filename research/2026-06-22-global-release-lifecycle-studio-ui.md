# Release lifecycle UI (F4) — Studio pane

## Context

Producing and running a self-contained app release (F4, commit `02987bd8b`) is **CLI-only** today:
`./equin release --composition <name> --target web [--dev]` builds the artifact, and testing
it means manually running the produced launcher/binary, hand-picking a non-colliding output/data
path, and opening the release port by hand. There is no in-app surface to choose a composition +
target, trigger a release, watch progress, see the artifact, or launch/preview it locally — so the
flow is undiscoverable and error-prone (notably the **104-byte Postgres/gateway Unix-socket
path-length limit** when the output dir is deeply nested).

This plan adds an **in-app UI for the local release lifecycle**: select composition + target → run
release → observe live progress/logs → see the artifact → launch/preview it locally. The release
*engine* is a new reusable plugin; the *UI* is a Studio pane (compositions already live in Studio).

### Locked scope decisions
- **UI home:** a new pane in the **Studio** app. Not a new top-level app, not the Deploy app.
- **Scope:** local lifecycle only. **Remote deploy is OUT** — it will be built later inside the
  Deploy app, reusing this engine (leave a clean handoff note, build nothing remote now).
- **Targets:** a small **target registry** (collection-consumer separation) so `web` is one
  contribution and `tauri` (F5) slots in later with zero consumer changes.

## Architecture: reusable engine + thin Studio consumer

Mirror the `build` plugin shape-for-shape. `build` is a top-level engine plugin (`run-build`,
`build_runs` table, `POST /api/build`) whose UI surfaces (logs, profiling) are sub-plugins
contributing into a `defineDetailSections` slot. Here the engine is the same; the UI surface lives
in Studio instead of a toolbar button.

**Why a separate `plugins/release/` engine rather than burying it under `apps/studio`:** the engine
(run model, spawn ownership, target registry, preview manager) is domain logic the future Deploy
remote flow will reuse. If it lived under `apps/studio`, the Deploy app would have to import *into*
`apps/studio`, inverting the dependency. The engine must be a sibling of `build`. Studio is just the
first consumer.

```
plugins/release/                                   # ENGINE umbrella (reusable, web/server/core/shared)
├── core/
│   ├── index.ts                                   # barrel
│   ├── targets.ts                                 # ReleaseTarget type + RELEASE_TARGETS array (single source of truth)
│   ├── endpoints.ts                               # triggerReleaseEndpoint, previewEndpoint, stopPreviewEndpoint
│   └── resources.ts                               # ReleaseRunSchema, releaseHistoryResource, previewStateResource
├── shared/index.ts                                # ReleaseStatus enum, short out-dir helpers
├── server/
│   ├── index.ts                                   # Resource.Declare(s), routes, onReady reconcile
│   └── internal/
│       ├── tables.ts                              # _releaseRuns pgTable + inflight partial unique index
│       ├── release-log.ts                         # releaseLog = Log.channel("release", { persist: true })
│       ├── run-release.ts                         # triggerRelease(): claim, detached spawn CLI, stream, finalize
│       ├── release-history-resource.ts            # release.history push resource
│       ├── handle-release.ts                      # implement(triggerReleaseEndpoint)
│       ├── preview-manager.ts                     # spawn/track/stop <staged>/launch; previewStateResource
│       ├── handle-preview.ts                      # implement(previewEndpoint / stopPreviewEndpoint)
│       └── reconcile.ts                           # reconcileOrphanReleases + reconcileOrphanPreviews on boot
└── plugins/
    ├── release-logs/                              # per-run live+persisted log section (mirror build-logs)
    └── release-profiling/                         # OPTIONAL gantt section (deferred — see Risks)

# Targets are NOT a sub-plugin: they are plain data in core/targets.ts (see §1).

plugins/apps/plugins/studio/plugins/release/       # STUDIO CONSUMER (web only)
└── web/
    ├── index.ts                                   # Pane.Register(s) + Studio.Sidebar nav (MdRocketLaunch)
    ├── panes.tsx                                  # releasePane (launcher+history) + releaseDetailPane (r/:runId)
    ├── slots.ts                                   # ReleaseDetail = defineDetailSections<{runId}>("release-detail")
    └── components/
        ├── release-launcher.tsx                   # composition dropdown + target picker + Run + history list
        ├── release-detail.tsx                     # status + sections host
        └── artifact-card.tsx                      # path + Preview/Stop + open-link
```

Barrel discipline (CLAUDE.md R1–R3): the Studio consumer imports only `@plugins/release/core`,
`@plugins/release/plugins/targets/web`, and `@plugins/release/plugins/release-logs/web`. Never deep
paths; never re-export engine symbols through the consumer barrel.

## 1. Targets — plain data in `core/`, no slot

Targets are a **closed list both runtimes need** (the web picker enumerates them; the server
validates against them and builds CLI args from them). That is the textbook case for `core/` — the
shared, cross-runtime, cross-plugin layer — **not** a slot. A web slot would be web-only data the
server can't see, manufacturing a web↔server gap that then "needs" codegen to bridge. There is no
gap to bridge: put one array in `core/`, both runtimes import it.

`plugins/release/core/targets.ts` (the single source of truth):
```ts
export interface ReleaseTarget {
  id: string;                                      // "web" | "tauri"
  label: string;                                   // "Web"
  implemented: boolean;                            // false ⇒ greyed "coming soon"
  buildArgs: (composition: string) => string[];    // UI choice → CLI flags
}
export const RELEASE_TARGETS: ReleaseTarget[] = [
  { id: "web", label: "Web", implemented: true, buildArgs: () => ["--target", "web"] },
  // tauri added here when F5 lands — one line, picker + validator both pick it up
];
export const releaseTargetById = (id: string) => RELEASE_TARGETS.find((t) => t.id === id);
```
- **Server** (`handle-release.ts`): `const t = releaseTargetById(target); if (!t?.implemented) throw HttpError(400)`; build the CLI call from `t.buildArgs(composition)`.
- **Web** (Studio launcher): map `RELEASE_TARGETS` → picker chips, disabling `!implemented`.
- **Studio consumer** imports `RELEASE_TARGETS` from `@plugins/release/core` directly.

**The icon stays web-only.** `core` carries no icon (the server has no business importing a UI
component — same spirit as the `no-lucide-react` guard). The web launcher decorates by id:
```ts
const TARGET_ICONS: Record<string, IconType> = { web: MdLanguage };  // web-only
```
The authoritative list of ids lives once in `core`; the web just attaches a glyph.

**Why not a slot/registry.** A slot earns its keep only when the set must be **open** (other plugins
contribute entries) *and* runtime-collected. A release target is not drop-in extensible: adding
`tauri` requires `release.ts` and the build pipeline to actually know how to build it — the metadata
is the easy 1%, the CLI/pipeline support the 99%. So the slot's extensibility is illusory here. If a
target set ever does need true plugin-contributed, both-runtime collection, the right tool is a dual
web+server contribution like `fields` (`fields.identity` web + `fields.storage` server), **not** a
web-only slot + codegen. We are nowhere near that.

## 2. Release run model + trigger endpoint

`plugins/release/server/internal/tables.ts` — mirror `_buildRuns` (incl. the durable-lock pattern):
```ts
export const _releaseRuns = pgTable("release_runs", {
  id: text().primaryKey(),                          // `release-${ms}-${rand}`
  composition: text().notNull(),
  target: text().notNull(),
  namespace: text().notNull().default(MAIN_WORKTREE_NAME),  // worktree-fork scoping
  status: text().notNull().default("running"),      // running|succeeded|failed
  startedAt: timestamp({withTimezone:true}).defaultNow().notNull(),
  finishedAt: timestamp({withTimezone:true}),
  exitCode: integer(),
  platform: text(),
  artifactPath: text(),                             // staged dir from --out / RELEASE.json
  port: integer(),                                  // baked release port (9100)
  error: text(),
  pid: integer(),                                   // detached CLI pid (internal; stripped from resource)
}, (t) => [
  uniqueIndex("release_runs_inflight_uniq").on(t.namespace, t.composition)
    .where(sql`${t.finishedAt} IS NULL`),
]);
```
Inflight uniqueness is scoped by `(namespace, composition)` — unlike build, concurrent releases of
*different* compositions are legitimate; only a duplicate in-flight release of the *same*
composition is blocked. Migration is regenerated by `./equin build` (never run drizzle-kit
manually).

`release-history-resource.ts` — copy `build-history-resource.ts`: push resource `release.history`,
explicit column list (omit `pid`), `where(eq(namespace, currentWorktreeName()))`,
`orderBy(desc(startedAt)).limit(50)`.

`core/endpoints.ts`:
```ts
export const triggerReleaseEndpoint = defineEndpoint({ route:"POST /api/release",
  body: z.object({ composition: z.string(), target: z.string() }) });
```

`run-release.ts` — **copy `run-build.ts` shape-for-shape**, reusing verbatim: `isPidAlive`,
`reconcileOrphan*`, the 23505 unique-violation claim race handling, the insert-with-own-pid-then-
swap-to-child-pid claim, line-streaming into a `Log.channel`. Differences:

- **Spawn: detached `Bun.spawn`, not `defineJob`.** The release CLI internally runs
  `./equin build --no-restart` — it does **not** restart this backend (unlike build). So the
  spawning backend survives the whole release; pid-liveness + boot reconcile gives restart-
  durability without job-queue weight, consistent with the sibling build plugin.
- **Short `--out` (the socket-path footgun).** Do NOT let the CLI default to
  `dist/release/<comp>-<target>-<timestamp>/` (deeply nested → blows the 104-byte socket limit at
  preview time, since the launcher roots PG/gateway sockets under `<out>/data`). Pass explicit
  `--out` under a short, stable root from `shared/index.ts` (e.g. `<SINGULARITY_DIR>/releases/
  <worktree>/<comp>-<target>`, stable not timestamped so re-release overwrites — the CLI `rmSync`s
  the out dir). The build artifact's own data dir isn't used for serving, but keep it short to be
  safe; the *preview* data dir is the real constraint (see §3).
- **`--dev`.** Spawn with `--dev` so the CLI stops at the staged dir (faster; produces the `launch`
  entrypoint preview needs). The packed single-binary is unnecessary for local preview.
- Stream stdout/stderr into `releaseLog.publish(line, stream)` (`Log.channel("release",
  {persist:true})` → `logs/release.jsonl`). On exit, read `<out>/RELEASE.json`, update the row
  (`status`, `finishedAt`, `exitCode`, `artifactPath`, `platform`, `port`). On failure write
  `error` + a `release-logs-<id>.json` fallback artifact (mirror build) so the detail pane shows
  persisted logs after the live stream ends.

`handle-release.ts`: `implement(triggerReleaseEndpoint, …)` → `releaseTargetById(target)`; throw
`HttpError(400)` if missing or `!implemented`; then call `triggerRelease(composition, target)` and
construct the CLI invocation from `t.buildArgs(composition)`.

## 3. Local preview / launch

Use the **`--dev` staged dir** (has `launch`, which self-roots `SINGULARITY_DIR` under its data
dir). Because the embedded PG/gateway open Unix sockets under the data root, **the data root must be
short**.

`preview-manager.ts` — an in-memory `Map<runId, { pid, port, url, dataRoot, status }>` plus a
`previewStateResource` (push) so the UI reflects running/stopped live:
```ts
export async function startPreview(runId): Promise<void> {
  const run = /* select; must be succeeded + have artifactPath */;
  const port = await pickFreePort(9101);            // probe upward; never 9000/9100
  const dataRoot = mkdtempSync("/tmp/sgp-");        // SHORT root ⇒ socket path safe
  const proc = Bun.spawn([join(run.artifactPath, "launch")], {
    detached: true, stdout:"pipe", stderr:"pipe",
    env: { ...process.env, SINGULARITY_DIR: dataRoot, PORT: String(port) },
  });
  // track pid/port/dataRoot; url = `http://${run.composition}.localhost:${port}`
  // stream launch stdout/stderr into releaseLog; previewState.notify()
}
export async function stopPreview(runId) {
  process.kill(-pid); rmSync(dataRoot,{recursive,force}); previewState.notify();
}
```
- **Socket-path fix:** `/tmp/sgp-XXXXXX/...sockets/<comp>.sock` is short by construction — the
  canonical mitigation for the 104-byte limit, chosen explicitly over a worktree-nested data dir.
  Verify the resulting socket path length before spawning; warn into `releaseLog` if it ever
  exceeds (shouldn't with `/tmp`).
- **Port collisions:** `pickFreePort` probes from 9101 upward (`Bun.listen`/connect check); each
  preview gets a distinct port. The bundled gateway routes by subdomain on its own port,
  independent of the dev gateway on 9000.
- **Cleanup / restart:** stop endpoint kills the process group and `rmSync`s the mkdtemp root.
  `onReady` reconcile reaps orphan previews (dead pid → drop from map; sweep stale `/tmp/sgp-*`).
  Previews are ephemeral local conveniences, not durable deploys (that's Deploy-app's job later).

`core/endpoints.ts`:
```ts
export const previewEndpoint     = defineEndpoint({ route:"POST /api/release/runs/:id/preview" });
export const stopPreviewEndpoint = defineEndpoint({ route:"POST /api/release/runs/:id/preview/stop" });
```
`previewStateResource`: `resourceDescriptor<Record<string,{status,port,url}>>("release.previews", …, {})`.

## 4. Studio pane UI

`plugins/apps/plugins/studio/plugins/release/web/panes.tsx` — mirror build's two-pane structure:

- **`releasePane`** (`segment:"release"`) → `ReleaseLauncher`:
  - composition dropdown: `useManifestItems()` (`@plugins/plugin-meta/plugins/composition/web`)
    filtered `category==="app"`.
  - target picker: `useReleaseTargets()` → chips, disabled when `!implemented`.
  - **Run release** button: `useEndpointMutation(triggerReleaseEndpoint)`.
  - run-history list: `useResource(releaseHistoryResource)` with status badge + relative time; row
    click → `openPane(releaseDetailPane, { runId }, { mode:"push" })`.
- **`releaseDetailPane`** (`defaultAncestors:[releasePane]`, `segment:"r/:runId"`, width 480) →
  `ReleaseDetail` host rendering `defineDetailSections("release-detail")` sections (exactly build's
  extensible pattern):
  - **Status/info** — badge, composition, target, platform, timing.
  - **Logs** (`release-logs` sub-plugin) — copy `build-logs`'s `build-log-section.tsx` verbatim,
    swapping channel `"build"`→`"release"` and the persisted endpoint to
    `GET /api/release/runs/:id/logs`. Live `useReconnectingWebSocket` → `/ws/logs`, `subscribe`
    channel `release`, `fromSequence`, + `primitives/auto-scroll`.
  - **Artifact card** (`artifact-card.tsx`) — `artifactPath`, **Preview**/**Stop**
    (`useEndpointMutation(previewEndpoint/stopPreviewEndpoint)`); when
    `previewStateResource[runId].status==="running"`, a clickable `<a href={url}>`
    (`http://<comp>.localhost:<port>`).

`web/index.ts` registers both panes + the sidebar entry (mirror `compositions/web/index.ts`):
```ts
Studio.Sidebar({ id:"release", ...sidebarNavItem({ title:"Release", icon: MdRocketLaunch,
  onClick: () => openPane(releasePane, {}, { mode:"root" }) }) })
```

**Deploy handoff note** (write into `plugins/release/CLAUDE.md`): the engine's run model, target
registry, and `triggerRelease` are remote-flow-ready. The Deploy app should later add a remote
transport over the same `_releaseRuns` + target registry rather than forking the lifecycle. Remote
deploy is explicitly out of F4 scope.

## Documentation deliverable — make `core/` the visible default for shared web/server code

The slot-then-codegen detour in the first draft was primed by the architecture docs: they make the
specialized mechanism loud (`web-sdk/CLAUDE.md` opens *"There are only two primitives: slots and
contributions"* and dwells on generated registries + `plugins-registry-in-sync`) while `core/`
appears only as a passive File-Structure line (*"Public API — types/utils importable
cross-plugin"*). The cheap, correct default is under-documented relative to the expensive exception.
Not lintable (no syntactic signal), so the fix is doc-level — state the default and exception side
by side where the reflex is primed:

1. **`plugins/framework/plugins/web-sdk/CLAUDE.md`** — add a **"Sharing code between web and
   server"** section right after *Concepts* (before slots dominate the reader's model): default to
   `core/` for plain shared data/logic and closed lists; reach for a slot only for an **open,
   runtime-collected** set, paying the codegen + `*-in-sync` cost. Rule of thumb: *"if you can write
   the whole list in one array today, it's `core/`; if a future plugin must add to it without
   editing your code, it's a slot."*
2. **`plugins/framework/plugins/server-core/CLAUDE.md`** — one cross-link to that section near
   *Internal/public separation*, so a server-first reader meets the same rule.
3. **Root `CLAUDE.md`, "Collection-consumer separation"** — one sentence scoping it to *genuinely
   open* sets: for a closed list both runtimes need, prefer plain data in `core/` — don't introduce
   a slot (and the web↔server codegen bridge it implies) for a set you can enumerate today.

## Critical files

Precedents to copy shape-for-shape:
- `plugins/build/server/internal/run-build.ts` — durable claim, detached spawn, streaming, orphan
  reconcile, `isPidAlive`, 23505 handling → `release/server/internal/run-release.ts`.
- `plugins/build/server/internal/tables.ts` — `_buildRuns` + inflight partial unique index →
  `release_runs`.
- `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` — live `/ws/logs` +
  persisted log section → `release-logs`.
- `plugins/framework/plugins/cli/bin/commands/release.ts` — the CLI being wrapped (`--out`/`--dev`/
  `--port` flags, `RELEASE.json` shape, socket-path footgun source).
- `plugins/reorder/plugins/node-types/web/internal/use-node-types.ts` — collection-consumer read
  hook for the target registry.
- `plugins/apps/plugins/studio/plugins/compositions/web/index.ts` — Studio pane + `Studio.Sidebar`
  registration; `useManifestItems()` source.

## Verification (end-to-end)

1. `./equin build` (regenerates the `release_runs` migration from `tables.ts`); then
   `./equin check migrations-in-sync` — no drift.
2. Open `http://<worktree>.localhost:9000` → **Studio** → **Release** sidebar entry; pane opens.
3. Pick a small app composition (`home` or `settings`); confirm **Web** selectable (and a disabled
   "Tauri (coming soon)" chip if pre-registered).
4. **Run release** → run row appears `running`; open detail; watch live `[1/5]…[done]` logs stream
   over `/ws/logs` with auto-scroll.
5. On completion: status `succeeded`, artifact card shows the staged path under the short out-root.
6. MCP `query_db`:
   `SELECT id,composition,target,status,exit_code,artifact_path,port,platform FROM release_runs
   ORDER BY started_at DESC LIMIT 5;` — one `succeeded` row, populated `artifact_path`, `port=9100`.
   Trigger two releases of the *same* composition → second 400s/no-ops; two *different* compositions
   both run (validates the `(namespace,composition)` inflight index).
7. **Preview** → `previewStateResource` flips `running`, link appears; click it → released app loads
   on its own port (independent of 9000). Confirm a `/tmp/sgp-*` data dir and no gateway
   socket-length error in logs.
8. **Stop** → process gone (`isPidAlive`), `/tmp/sgp-*` removed, state `stopped`.
9. Restart backend mid-release and mid-preview → orphan reconcile leaves no phantom `running` rows
   and no leaked preview processes.
10. `bun e2e/screenshot.mjs --url …/studio --click "Release"` → pane + Run button render; verify
    disabled-state pre/post selection.

## Risks

- **104-byte socket-path limit** — *the* dominant footgun. Mitigated by a short `--out` for the
  build AND a `/tmp` mkdtemp `SINGULARITY_DIR` for preview; verify length before spawning, warn on
  overflow.
- **Port collisions** — `pickFreePort` from 9101 upward, distinct per preview; never 9000/9100.
- **Spawn ownership across restart** — detached spawn + DB-pid (release) / in-memory map +
  boot reconcile (preview). The release CLI uses `--no-restart`, so it does not kill this backend —
  ownership is *more* stable than build's.
- **Worktree vs main** — release CLI passes `--allow-main`; namespace-scope the history resource and
  inflight index by `currentWorktreeName()` (worktree DBs fork main's rows — same phantom-state
  hazard build already solves).
- **Targets are plain `core/` data, not a slot** — closed list both runtimes import; no web↔server
  gap, no codegen, no allowlist to keep in sync. (Earlier draft over-applied the slot pattern; see
  §1 and the Documentation deliverable.)
- **Gantt progress (deferred)** — `release-profiling` is optional and depends on adding a
  `release-profile-<id>.json` emission to `release.ts`; the CLI currently only logs `[n/5]` lines.
  Recommend deferring to keep F4 tight; `GanttSection`/`groupByPhase` from
  `@plugins/debug/plugins/profiling/web` are ready when we add it.
```
