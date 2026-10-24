# File watchers in the Background activity catalog

## Context

Debug → Background activity (`plugins/infra/plugins/background`, plan
`research/2026-09-30-infra-background-activity-catalog.md`) lists jobs, retention
sweeps, supervised jobs, warm-ups and timers. File watchers are not on it; that plan
deferred them to its Phase 3 ("file watchers as their own kinds"). This plan is that
phase for watchers.

`createFileWatcher` (`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`)
has 15 call sites: 14 in server code and 1 in the CLI (`cli/await`). Watchers react on their own and hold
native resources. On darwin, a `writesWhileOpen` (kqueue) watcher holds one FD per
file. FD exhaustion has crashed macOS before. Today a human cannot see:

- which watchers exist, what they watch, and how many are open;
- what each one last reacted to, and whether its handler threw.

Two structural gaps sit behind this:

1. **No declaration unit.** `createFileWatcher(opts)` is a per-instance call with no
   name a human reads and no description. The `no-raw-set-interval` ignore entry
   already says "the watcher is the declared unit". Nothing declares that unit yet.
2. **Bypasses are expressible:**
   - `watch-edited-files.ts` (conversation-view/code) calls `getParcelWatcher().subscribe`
     directly and hand-rolls its own debounce and ceiling.
   - `node:fs` `watch` / `watchFile` are not linted at all.
     `cli/op-runtime/cli/admission-valve.ts` uses `fs.watch`.
   - `watcher-safety/no-direct-parcel-watcher` bans only value imports of `@parcel/watcher`.

Intended outcome:

- Every in-process file watcher is declared once, with a required description.
- Each declaration is one catalog entry. The entry shows:
  - its open instances and the directories each one watches;
  - its backend;
  - its last change batch (when it happened, how many events, sample paths);
  - its handler runs.
- Every other way to watch files is a lint error unless it is listed with a reason.

## Design

### 1. `defineFileWatcher`: the declared unit (file-watcher plugin)

Declaration and instance become separate things. This is the same split as
`defineTimer` (`plugins/infra/plugins/background/plugins/timer/shared/timer.ts`) and
`defineJob`.

```ts
// module scope, in the owning plugin
export const allowFilesWatcher = defineFileWatcher({
  name: "conversation-view.allow-files",          // unique; throws on duplicate
  description: "Notices when a conversation's worktree gains or loses a bypass-permission file.",
  // static policy — the same for every instance:
  extensions?, ignore?, debounceMs?, ceilingMs?, writesWhileOpen?, reconcileMs?,
  mainOnly?: boolean,                               // like defineTimer
});
// register: [allowFilesWatcher]    (captures declaredIn via registeringPlugin)

// per instance, wherever the caller creates one today:
const w = await allowFilesWatcher.start({
  dirs: [worktreePath],
  label?: conversationId,        // how the catalog names this instance
  onChange, onReconcile?,        // per-instance closures
});
await w.stop();
```

- The handle is `FileWatcherDecl & Registration`, with `_kind: "file-watcher"`,
  `_factory: "defineFileWatcher"` and `_doc: {label: name, detail: description}`. The
  plugin docs pick it up like jobs and timers.
- `description` is a **required** field (a tsc error at every call site). An empty
  string throws at define time, like `jobs/server/internal/registry.ts:627`. All
  ~15 sentences are written in the same change. There is no optional phase.
- `start()` throws in two cases:
  - the declaration was never registered, which is the `defineTimer` rule;
  - `mainOnly` is set and the process is not main. This moves the `isMain()` gates now
    hand-written at the reports outbox and corpus-index call sites into the declaration.
- The engine (debounce, ceiling, reconcile, kqueue sizing) moves from `server/internal`
  to `shared/engine.ts`, unchanged. The engine also records into a module-level
  registry, keyed by declaration name, holding:
  - **Instances:** a `Map<instanceId, {label, dirs, backend, openedAt}>`. Added on
    `start`, removed on `stop`.
  - **Last batch:** `{at, eventCount, samplePaths (≤5), types}`, updated on every
    `onChange` dispatch.
  - **Run ring:** each `onChange` or `onReconcile` dispatch is a `BackgroundRun`
    (start, duration, error if the handler throws). It is capped at `RECENT_RUNS_MAX`,
    with `runs`, `failures` and `lastSuccessAt` counters. This is the same ring as
    `timer.ts` `record()`.
  - **Notify throttle:** the same as timers. It notifies only when the outcome changes,
    when an instance opens or closes, or after ≥60 s of quiet. `transcript-watcher`
    runs with `debounceMs: 0` and fires constantly, so recording must stay O(1) and
    mostly silent.
  - **`onWatcherActivity(listener)`:** a change subscription, the same shape as
    `onWarmupRun` and `onJobRunsChanged`.
- **Barrels:**
  - `server/index.ts` exports `defineFileWatcher`, `listFileWatchers`,
    `fileWatcherRecentRuns`, `onWatcherActivity`, and the types.
  - `createFileWatcher` and `getParcelWatcher` are **no longer exported**, so an
    undeclared watcher cannot be written. The one `getParcelWatcher` consumer is
    migrated (see §3).
- **CLI:** `cli/await` watches for the life of a foreground command. That is not
  background activity, and a CLI process has no catalog. A new `cli/index.ts` barrel
  exports `watchForCommand(opts)`: the same engine with no registry, and a type that
  requires `dirs` + `onChange`. `cli/await/cli/run.ts:312` switches to it. The
  boundary table already lets `cli` import `cli`.

### 2. Background arm: `plugins/infra/plugins/file-watcher/plugins/background-arm`

This follows the warmup and jobs arm pattern. Config_v2, git-watcher and others are
imported early at boot, so the file-watcher barrel must not import the catalog.

- `defineBackgroundKind({kind: "file-watcher", order: 30, label: "File watchers", list, recentRuns})`.
- `onReady: () => onWatcherActivity((name) => kind.changed(name))`.
- Each declaration becomes one entry:
  - `group`: "File watchers".
  - `trigger`: the new variant `{kind: "file-change"}`.
  - `scope`: `mainOnly ? "main" : "every-worktree"`.
  - `runsHere`: `!mainOnly || isMain()`.
  - `lastRun`: `ring[0]`, and `history` comes from the counters.
  - `canRunNow`: false.
  - `facts` (a fact is a label and a value):
    - `Open` — the instance count, e.g. `3`, or `0 (opens while subscribed)`. The
      Watching fact carries the paths.
    - `Backend` — `FSEvents` or `kqueue (1 FD per file, capped at 5,000 entries)`.
    - `Watching` — one fact per instance, capped at 10 with "…and N more":
      `label — dir1, dir2 · since HH:MM`.
    - `Last change` — `12 events · 14:02:31 · a.jsonl, b.jsonl, …`.
    - `Runs in` — "This process, in memory — resets on restart" (the timer's wording).
- **Catalog changes** (`plugins/infra/plugins/background/plugins/catalog`):
  - Add `{kind: "file-change"}` to `BackgroundTriggerSchema` (`core/internal/entry.ts`).
  - Add the case to `triggerWords` in `web/internal/present.ts`, reading "When watched
    files change". The switch is exhaustive, so tsc finds every other place to update.
    `entry-detail.tsx` and `background-view.tsx` only branch on `cron`.
  - "Open: 0" needs no status work: the entry shows its lastRun outcome, or `never`.

The live DataView lists and groups the new entries with no other catalog change,
because the `group` options come from the data.

### 3. Migrate every call site

The same edit applies everywhere: move the static options plus a written description
into a module-level `defineFileWatcher`, add it to the plugin's `register`, and turn
`createFileWatcher({...})` into `decl.start({dirs, label?, onChange, onReconcile?})`.

Representative sites:

- `config_v2/server/internal/config-watcher.ts:21`
- `infra/git/plugins/git-watcher/server/internal/watcher.ts:80`
- `conversations/plugins/transcript-watcher/server/internal/watcher.ts:101` (one process-wide instance)
- `conversations/plugins/conversation-view/plugins/allow-monitor/server/internal/allow-files-resource.ts:41` (one instance per conversation, labelled with the conversation id)
- `reports/plugins/outbox/server/internal/watcher.ts:86` (`mainOnly`)
- `infra/corpus-index/server/internal/corpus-index.ts:503` (`mainOnly`)
  - `defineCorpusIndex` declares one watcher per index. Its name is derived from the
    index name and its description from the index description, the way retention
    derives its description.
- `infra/jobs/plugins/supervised-job/server/internal/run/supervisor.ts:348` (kqueue)
- The remaining sites: sentinel, op-store, prototypes files, midi folders, plugin-tree,
  google-maps, deps.

**`watch-edited-files.ts`** (conversation-view/code) moves onto a declaration
(`conversation-view.edited-files`, one instance per worktree room). Its hand-rolled
debounce and ceiling (`:132-152`) are deleted in favour of the engine's.

### 4. Make bypasses a lint error

Extend `plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety`:

- `no-direct-parcel-watcher` stays as it is. Its exemption path becomes the
  file-watcher plugin's `shared/`.
- **New `no-raw-fs-watch`**, scoped to the `/server/`, `/central/`, `/shared/`, `/cli/`
  and `/bin/` path segments. Tests are skipped, the same scoping as
  `no-raw-set-interval`. It reports:
  - `watch`, `watchFile` and `unwatchFile` imported from `node:fs`, `fs`,
    `node:fs/promises` or `fs/promises`;
  - any member access `fs.watch`, `fs.watchFile` or `fs.promises.watch`;
  - `chokidar` imports.

  The message points to `defineFileWatcher`, or `watchForCommand` in the CLI.
- `ignores["no-raw-fs-watch"]` in `watcher-safety/lint/index.ts` gets one entry with
  its reason: `cli/op-runtime/cli/admission-valve.ts`. It watches one latch file on the
  build admission hot path, and `node:fs` avoids loading the native addon there. Any
  future entry needs a written reason.
- Add a rule test file, like `no-raw-set-interval.test.ts`.
- Update the ignore reason for `create-file-watcher.ts` in
  `detached-work-safety/lint/index.ts` (`no-raw-set-interval`) to the new
  `shared/engine.ts` path, and have it name the catalog entry the timer now reports
  through.

### 5. Docs

- `file-watcher/CLAUDE.md`: declaration vs instance, required description, `mainOnly`,
  and the CLI barrel.
- Catalog research doc Phase 3: mark file watchers as done, pointing here.
- Regenerate plugin docs through the build.

## Critical files

- `plugins/infra/plugins/file-watcher/{server/index.ts, server/internal/*, shared/engine.ts (new), shared/registry.ts (new), cli/index.ts (new), CLAUDE.md}`
- `plugins/infra/plugins/file-watcher/plugins/background-arm/{server/index.ts, server/internal/provider.ts}` (new)
- `plugins/infra/plugins/background/plugins/catalog/{core/internal/entry.ts, web/internal/present.ts}`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety/lint/*`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/detached-work-safety/lint/index.ts`
- The 15 call sites above, plus `watch-edited-files.ts`

Reuse:

- `registeringPlugin` and `Registration` (the `defineTimer` precedent in
  `background/plugins/timer/server/internal/define.ts`);
- `RECENT_RUNS_MAX` and `BackgroundRun` from `catalog/core`;
- `isMain()`;
- the arm layout from `warmup/plugins/background-arm`.

## Verification

1. `./equin test plugins/infra/plugins/file-watcher` covers:
   - the existing engine tests, moved with the engine;
   - new registry tests: instances are added on start and removed on stop; the ring is
     capped at 20; a handler that throws records `failed`; a duplicate name throws;
     `start()` on an unregistered declaration throws; a `mainOnly` declaration off main
     throws.
2. `./equin test` on the watcher-safety lint plugin covers the fs.watch,
   watchFile, promises and chokidar cases, and the ignore entry.
3. `./equin build` must pass with checks green: type-check (the required
   description and the exhaustive trigger switch), eslint, and plugins-doc-in-sync.
4. E2E: extend `catalog/e2e/verify.ts`, or run `screenshot.ts --path` on the
   background pane.
   - Assert a "File watchers" group with entries for config_v2, git-watcher and
     transcript-watcher.
   - Open a conversation (allow-monitor, a per-conversation instance), then open the
     `conversation-view.allow-files` entry. `Open` should be ≥1 and `Watching` should
     list the worktree.
   - Edit a config `.jsonc` in the worktree. The config watcher's `Last change` and
     recent runs should update within ~3 s.
