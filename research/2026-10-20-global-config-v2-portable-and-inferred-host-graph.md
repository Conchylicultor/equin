# config_v2 portable split + an inferred browser-host graph

Track: "Track: apps running in the browser" → subtrack "portable server code (server/ vs machine/)"
(`block-323b766d-7ddf-4555-820a-80d82d6737f3`), row "[Hubs] config_v2 split". Previous slice:
`2026-10-20-global-demo-stubs-to-worker.md`. Research that fed this plan (two multi-agent runs) is
summarised here; the withdrawn alternative (a `configs/` folder replacing `ConfigV2.Register`) is
recorded under "Rejected".

## Context

- config_v2's `Demo.Resource` (`config_v2/web/internal/demo-resource.ts`) is the last page-side
  backend in `/demo`. It keeps DemoScope's page server, the `Demo.Resource` slot and
  `composeBrowserServers` alive.
- **Why config can't simply run in the worker today:**
  - `config_v2/server` is not portable. It uses `node:fs`/`node:path` (`registry.ts:1-2`), the file
    watcher (`:6`), `paths/server` (`:44`), `CONFIG_DIR` (`:46`) and the agent-write ledger (`:48-52`),
    and carries 9 files of `no-platform-api` debt (`config_v2/exempt/index.ts`).
  - So no plugin that registers config (`ConfigV2.Register`, 77 in `server/`, 4 in `machine/`) can
    boot in the worker. 31 of them are register-only barrels whose only non-portable import is
    `config_v2/server`.
  - A config the page reads with no server registration crashes `useConfig`
    (`use-config.ts:~73`, "registered on web but the server has no matching ConfigV2.Register").
- **The worker graph is hand-written** (`demo/bin/browser-host.plugins.ts`, 33 roots →
  72 generated entries). The desktop server infers its graph: it loads every plugin of its
  composition (`@composition-server-registry`, `server-core/bin/active-runtime.ts:15`). The browser
  host should do the same, so the descriptors of every portable registering plugin reach the worker
  through the existing `ConfigV2.Register`, with no list.
- **Measured:** the `agent-manager` composition's bundle (`resolveComposition`) holds exactly 63 of
  today's 72 entries as `portable: true` server barrels. The other 9 are exactly the browser
  providers that `base-exclusions` negates (`plugin-meta/plugins/composition/core/config.ts:176-193`).
  Inference therefore reproduces today's graph with nothing dropped.

**This session's outcome:**
1. config_v2 is split into a portable `server/` and a desktop `machine/`; the desktop is unchanged.
2. The browser host's graph is inferred from a composition; `hostPlugins` is deleted.
3. The inferred-graph design is recorded on the subtrack page.

**Next session** (not planned in detail here): deliver the committed layer to the worker; split
the registering plugins the demo reads config from; move the two page-server policies (an unserved
key as a loud loader-failed naming the key; the one-at-a-time "Not available in the demo" toast);
delete the page server, the `Demo.Resource` slot, `composeBrowserServers` and `createBrowserServer`.

## Decisions

Agreed with the user (2026-10-20):
- `ConfigV2.Register` stays the registration path. No `configs/` folder.
- The worker graph is inferred this session, not hand-written.
- The registering-plugin splits, the policies and the deletions are next session.

Taken in this plan (recommendations; flag if you disagree):
- **D1. The host names one composition:** `agent-manager`. It reproduces the graph exactly;
  `singularity` would add 11 unreviewed conversation-view barrels. Because the host names its
  composition, `browser-host.generated.ts` stays committed and checked by `plugins-registry-in-sync`.
- **D2. Portability stays the `portable: true` flag this session,** read statically through one
  predicate `isPortableServerBarrel` (moved out of `boundaries/check/portable-closure.ts:105-112`
  into `plugin-meta/plugins/parse-utils/core`). Deriving it from the closure would silently admit
  11 more barrels (e.g. `infra/mcp`); follow-up.
- **D3. Interim config in the demo: the page stays authoritative.** compose routes a key both serve
  to the first part that claims it (`compose.ts:47-48`), and DemoScope composes `[page, hosted]`,
  so the page wins. The page additionally claims `config-v2.tiers`, `conflicts`,
  `conflict-locations` and `modified-counts`, answering `DemoMissingError` (today's answer).
  Otherwise those would fall through to the worker's empty registry and return stand-in values
  (`modified-counts` `{}`, `resource.ts:~484`). Rejected: deleting the page `Demo.Resource` now (the
  worker registry is empty this session, so every config read would crash); excluding config_v2
  from the graph (a special case in the inference).
- **D4. Committed-layer delivery is deferred.** This session the browser `ConfigGitLayer` provider
  throws a loud error naming the next-session step. It is never called: the worker's registry is
  empty, and `gitBacksScope` runs only when a registered scope is removed. Delivering it now would
  change web-artifacts and release keying with no reader to exercise it.
- **D5. Naming:** `ConfigStoreImpl` (the widened core interface) and `ConfigStore` (the host-service
  handle), following `MigrationSourceImpl` / `MigrationSource`.

## Design

### A. Host services

```ts
// config_v2/core/internal/store.ts (replaces memory-config-store.ts; ConfigDocumentFile moves from server/internal/config-ledger-key.ts)
export type ConfigDocumentFile = "origin" | "override" | "ancestor";
export interface ConfigDocRef { storePath: string; scopeId?: string }   // undefined = base
export interface ConfigFileRef extends ConfigDocRef { file: ConfigDocumentFile }

export interface ConfigStoreImpl {
  proxy(ref: ConfigFileRef): ConfigProxy;              // sync read/write/exists (core/internal/config-proxy.ts)
  remove(ref: ConfigFileRef): void;                    // no-op when absent
  stamp(ref: ConfigFileRef): string;                   // changes on every write (resource.ts fileStamp)
  scopes(storePath: string): string[];                 // scope-paths.ts discoverScopeIds
  dropScope(storePath: string, scopeId: string): void; // empty-scope cleanup (scope-fork.ts)
  watch(ref: ConfigDocRef, onChange: () => void): Disposable;
  armed(): Promise<void>;                              // configWatcherArmed
  edit<T>(doc: ConfigDocRef, writer: WriteOrigin | undefined, operation: string, mutate: () => T): T; // agent-write ledger; memory = mutate()
}
export interface ConfigGitLayerImpl {
  /** Whether the repo commits a scoped document for (storePath, appId) — the one committed-layer read the portable server makes (scope-fork.ts:101-111). */
  hasScope(storePath: string, appId: string): boolean;
}
export function createMemoryConfigStore(): ConfigStoreImpl; // widened; demo-resource.ts keeps using it

// config_v2/server/internal/host-services.ts
export const ConfigStore = defineHostService<ConfigStoreImpl>("config-v2.store");
export const ConfigGitLayer = defineHostService<ConfigGitLayerImpl>("config-v2.git-layer");
```

The running server never resolves values from the repo's `config/`: it cascades over the
build-propagated `.origin.jsonc` (`tier-logic.ts:73`). The repo is read only by raw-file, the
`gitBacksScope` check and a watch for raw-file, so `ConfigGitLayer` needs only `hasScope`.

### B. `config_v2/server` becomes portable

| File | Change |
|---|---|
| `registry.ts` | Drop `node:*`, `acquireDirWatch`, `REPO_ROOT`, `CONFIG_DIR` and the ledger. All file I/O goes through `ConfigStore.get()` (`proxy`, `remove`, `watch`, `edit` on every write path). `CacheEntry` holds refs, not paths. Export `reloadConfigDocument(storePath, scopeId)` (for the machine restore) and `onDocumentChange(listener)` (called from `notifyDocument`). |
| raw-file (`readRaw`, `watchGitLayer`, `configRawFileServed`) | Moves to `config_v2/machine/internal/raw-file.ts`, live through `onDocumentChange`. `configRawFile` (`core/internal/resource.ts:193`) gains `needsMachine`; its 3 readers in `settings/web/components/{config-detail,conflict-diff,invalid-diff}.tsx` handle `unavailable`. |
| `resource.ts` | Store instead of `jsoncConfigProxy`; `fileStamp` → `stamp(ref)`; refs instead of `join`. |
| `scope-paths.ts`, `scope-snapshot.ts` | Pure string helpers; `readdirSync` → `scopes()`; writes through `proxy`. |
| `scope-fork.ts` | `gitBacksScope` → `ConfigGitLayer.get().hasScope(…)`; removal via `remove`/`dropScope`; writes via `edit`. Drop `paths/server`. |
| `config-dir-change.ts` | Stays in `server/` (`theme-engine/server/internal/document-head.ts` imports it); `machine/` feeds it. |
| `fork.ts` (`forkConfig`) | Moves to its only importer, `conversations/plugins/workspace/plugins/worktree/server/internal/worktree-workspace.ts` (already exempt). |
| `orphan-audit.ts` (+ test) | Moves with `debug/plugins/config-orphans/server` into `config-orphans/machine/`; `configOrphansReport` gains `needsMachine`; its 2 readers handle `unavailable`. |
| `config-watcher.ts`, `jsonc-proxy.ts`, `config-dir.ts` | Move to `config_v2/machine/internal/`. |
| `index.ts` | Keeps `initRegistry`, the 6 portable values (values, conflicts, tiers, scopes, conflict-locations, modified-counts) and the 4 scope routes. Watcher `register`/`onReady`/`onShutdown` move to machine. `configWatcherArmed` delegates to `ConfigStore.get().armed()`. `portable: true` is added only at step 3. |
| `config_v2/exempt/index.ts` | Deleted: the acceptance test for the split. |

### C. `config_v2/machine` (new)

- `index.ts` contributes `ConfigStore.provide(fileStore)` and `ConfigGitLayer.provide(repoLayer)`,
  spelled literally (`test/bun-preload.ts` finds machine barrels by `/\.provide\(/`), plus the
  watcher lifecycle, raw-file and the `notifyConfigDirChange` feed.
- It imports through `@plugins/config_v2/server`, never `../server/internal`, so the generated
  `config_v2#machine` entry gets its `dependsOn: ["config_v2"]` edge (`machine.generated.ts`).
- `file-store.ts`: ref → `CONFIG_DIR/<dir>/<scope>/<name>{.origin,,.ancestor}.jsonc` via
  `jsoncConfigProxy`, `statSync` stamps, watcher-backed `watch`, and the agent-write ledger, whose
  restore writes the bytes and calls `reloadConfigDocument`. No I/O at module evaluation.
- `repo-layer.ts`: `hasScope` = `existsSync(repoConfigDir()/<hier>/@app/<appId>/<name>.jsonc)`,
  today's semantics.
- Update the stale comments that name config_v2's server files (sentinel check, deploy CLI,
  declare-namespace, run-exec, config-origin-gen, `server-core/CLAUDE.md` service list,
  `config_v2/CLAUDE.md`).

### D. Browser config providers

- New `plugins/config_v2/plugins/browser-store/server` (`portable: true`): provides `ConfigStore`
  (`createMemoryConfigStore()`) and an undelivered `ConfigGitLayer` that throws
  `config-v2: committed layer not delivered to this host (storePath …) — next session`.
- Add `"!config_v2.browser-store.**"` to `base-exclusions` in both `composition/core/config.ts` and
  `config/plugin-meta/composition/compositions.origin.jsonc`, in the same change (codegen reads the
  committed JSONC before origins regenerate; a `config.ts`-only edit would boot two providers on
  the desktop). Update `config.test.ts`'s pinned list.

### E. Inferred host graph

- **Declaration:** `demo/bin/browser-host.plugins.ts` → `demo/bin/browser-host.composition.ts`
  holding `export const hostComposition = "agent-manager";`, read by regex and never evaluated
  (update `DECLARATION_RE`, `discoverBrowserHosts`, the header in `codegen/core/browser-host-gen.ts`).
- **`deriveBrowserHostGraph(ctx, host)`** in codegen core, shared by the generator,
  `plugins-registry-in-sync` and tests:
  1. **Bundle:** `resolveComposition(ctx.graph, flattenManifest(row, readCompositionManifestsFromDisk(root))).bundle`
     (the path `main-bundle.ts` and `app-artifacts.ts` already use). Throw on an unknown composition.
  2. **Roots:** every bundle plugin whose `server/index.ts` satisfies `isPortableServerBarrel`, plus
     every portable server barrel reached from `bin/browser-host.ts` (the seed's imports become
     roots by rule).
  3. **Providers:** candidates are the portable server barrels under a `base-exclusions` negative
     that `.provide(` a service declared in the graph; iterate to a fixpoint. Exactly one provider
     per declared service, else throw naming the service and candidates. Added after resolution,
     never by flipping negatives (flipping would revive `review.plugin-changes` and its imports).
  4. **Closure guard:** any server barrel a graph member's (or the entry's) `importClosure` reaches
     that is not in the graph throws with the import chain, moving today's boot assert to build.
  5. **Emit:** `hostEntries` as today, plus `hostProviders` (service id → plugin). The header names
     the composition.
- **New check `host-services:provider-placement`** (`server-core/check/`): a portable `server/` that
  `.provide(`s must sit under a `base-exclusions` negative; every declared service has exactly one
  `machine/` provider and exactly one browser candidate.
- Seed and scenario data stay in the scenario plugin (`demo/bin/seed.ts`, `demo/core`).
- `browser-host.test.ts`: `BUNDLED_SOURCE` becomes `hostProviders["database.migration-source"]`.

### F. Interim demo behaviour (this session)

- The worker additionally boots `config_v2` and `config_v2/plugins/browser-store` (graph 72 → 74),
  with an empty registry.
- The page answers `scopes`, `values` and set-field from the committed layer as today, and now
  also claims the other 4 `config-v2.*` keys with `DemoMissingError`. The rendered demo is unchanged.
- Known glitch: the 4 scope routes exist only on the worker, so calling one would toast on the page
  before the worker answers (`compose.ts:56-65`). Verify no agent-manager surface calls one.

## Critical files

- `plugins/config_v2/{server,core,exempt,web/internal/demo-resource.ts,CLAUDE.md}`, new
  `plugins/config_v2/machine/`, new `plugins/config_v2/plugins/browser-store/`
- `plugins/config_v2/plugins/settings/web/components/{config-detail,conflict-diff,invalid-diff}.tsx`
- `plugins/debug/plugins/config-orphans/`,
  `plugins/conversations/plugins/workspace/plugins/worktree/server/internal/worktree-workspace.ts`
- `plugins/plugin-meta/plugins/composition/core/{config.ts,config.test.ts}`,
  `config/plugin-meta/composition/compositions.origin.jsonc`
- `plugins/framework/plugins/tooling/plugins/codegen/core/browser-host-gen.ts`,
  `plugins/plugin-meta/plugins/parse-utils/core`,
  `plugins/framework/plugins/tooling/plugins/boundaries/check/portable-closure.ts`,
  `plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts`,
  new `plugins/framework/plugins/server-core/check/`
- `plugins/framework/plugins/server-core/core/testing/index.ts` (scoped `withHostServices`)
- `plugins/apps/plugins/agent-manager/plugins/demo/{bin/browser-host.composition.ts,bin/browser-host.generated.ts,bin/browser-host.test.ts,bin/browser-host.ts,CLAUDE.md}`

## Execution order (stop and report at every gate)

0. `git fetch origin main && git rebase origin/main`.
1. **Inferred graph only, config_v2 untouched** (E). Build.
   Gate: `browser-host.generated.ts` differs only in its header and `hostProviders`; the 72
   entries are identical; the demo and codegen tests pass. Any entry added or dropped, or the guard
   throwing on a latent import: STOP.
2. **Desktop split, flag not set** (A, B without `portable: true`, C, the fork/orphan/raw-file
   moves, the `needsMachine` readers, `config_v2/exempt` deleted). Build.
   Gate: `./singularity check type-check boundary-rules plugin-boundaries config-v2:registrations-paired plugins-registry-in-sync exempt eslint`;
   `config_v2#machine` depends on `config_v2`; `./singularity test plugins/config_v2 plugins/debug/plugins/config-orphans`;
   the desktop smoke list below. Any desktop divergence: STOP.
3. **Flip to portable, in one step** (D; `portable: true` on `config_v2/server`; the page's 4 extra
   claims; test updates). `./singularity check boundaries:portable-closure` before building, then
   build. Gate: graph diff is exactly `+config_v2`, `+config_v2/plugins/browser-store`; no
   node-builtin offenders in the host build; the desktop boots with no `assertHostServices` error;
   the boot test passes. On a portable-closure failure, report the chain; never add an exemption.
4. Verification and measurements; update the stale docs.
5. Wiki: `read_page` the subtrack page, then update it (it is an agent page): tick/annotate the
   "[Hubs] config_v2 split" row, add "[Framework] the browser host's graph is inferred from its
   composition (no hand-written hostPlugins)" with D1–D3 and E, the status and the measurements.
6. Full `./singularity check`; report. File the next main task (next-session list below) with the
   subtrack page id and `block-361815ed-5750-413a-b5ab-31c5dc855144`. No push.

## Verification

- **Checks:** all of `./singularity check`; in particular `plugins-registry-in-sync`,
  `boundaries:portable-closure`, `host-services:provider-placement`, `config-v2:registrations-paired`,
  `exempt`, `migrations-in-sync`, `type-check`.
- **Tests:**
  - New `config_v2/server/internal/registry.test.ts` over a memory store and a fixture layer,
    provided through a scoped `withHostServices(overrides, fn)` (never the process-wide
    `provideHostServicesUnbooted`); it calls `initRegistry` itself. It covers base and scoped reads,
    fork-on-write, a 400 on a bad field, reset/ack/merge/delete-override, scope membership,
    git-backed versus plain scope removal, `edit` on every mutation, `reloadConfigDocument`, and
    `onDocumentChange`.
  - `browser-store`: the undelivered layer throws with the path and the hint.
  - `deriveBrowserHostGraph`: reproduces the committed entries; a non-portable barrel in a closure
    throws with the chain; zero or two providers throw; `review.plugin-changes` is not revived.
  - `demo/bin/browser-host.test.ts`: the worker serves exactly the 6 portable `config-v2.*` keys
    (raw-file absent); the page `Demo.Resource` claims all 6 (pins D3); `DEMO_READS` still passes.
  - `./singularity test plugins/config_v2 plugins/debug/plugins/config-orphans plugins/plugin-meta/plugins/composition plugins/apps/plugins/agent-manager/plugins/demo plugins/framework/plugins/browser-server plugins/tasks/plugins/task-category`
- **Browser:** `exhibit-shot.ts --id agent-manager/demo`; `/debug/exhibits/x/agent-manager/demo`
  and `/demo` via `browser_*`: no error boundary; no unknown-key, contract or use-config guard
  errors in `browser_console`; a config toggle round-trips; no "Not available" toast during normal
  navigation.
- **Desktop unchanged:** `config_v2/e2e/config-live-values.ts` passes. Settings → Config:
  conflicts badge and detail, tiers, raw-file (live after a write and after a repo `config/` edit),
  reset/merge/acknowledge/delete-override, fork and remove of an app scope (a git-backed scope falls
  back to its committed config). An agent write then restore. Theme switching and per-app theme
  scope fork. Debug → config-orphans and the stranded-config notice.
- **Measured** (before → after, recorded on the subtrack page): worker bundle bytes, module count,
  plugin count (72 → 74), worker boot-to-ready time. Baseline 19.0 MB / 1,084 modules.

## Risks

- The `registry.ts` rewrite (1,045 lines): a missed `edit` silently makes an agent write
  unrestorable. The registry test asserts it on every write path.
- Raw-file liveness now depends on `onDocumentChange`; the desktop smoke covers it.
- Test isolation: a suite swapping host services without the scoped helper leaks into later suites.
- The closure guard may surface a latent non-portable import among today's 72 (gate 1 shows it
  before any config change).
- The undelivered `ConfigGitLayer` is a tripwire: the first portable registering barrel breaks
  worker boot, with an error naming the next step.

## Next session

- Deliver the committed layer to the worker (alias `@composition-config-layer` in the host vite
  build, per-composition input keying, origin seeding) and make the browser `ConfigGitLayer` real.
- Flag or split the registering plugins the demo reads config from (the 9 register-only barrels in
  the bundle; `reports`, `tasks/automations`; the 3 machine registrars, which move back to `server/`).
- The two page-server policies, then delete the page server, the `Demo.Resource` slot (with D3's
  extra claims), `composeBrowserServers` and `createBrowserServer`.
- Fix the reorder origin loss in `codegen/core/config-git-layer-gen.ts:89-93` (the layer keeps only
  arranged documents, so build-origin reorder layouts fall back to `items: []`).
- Follow-ups: derive portability from the closure; derive the provider negatives in
  `base-exclusions` from the providers themselves.

## Rejected

- **A `configs/` folder per plugin replacing `ConfigV2.Register`.** It only worked around the
  hand-written worker graph; once the graph is inferred from the composition, registration reaches
  the worker the same way it reaches the desktop.

## Out of scope

- A persistent (IndexedDB/OPFS) user layer; web-artifacts and release changes; deleting
  `WebRegister` or the use-config guard; any `./singularity push`.
