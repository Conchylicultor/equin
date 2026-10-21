# Demo config from the worker: scope the demo subtree to its host composition, then delete the page server

*Plan for the session after f4ec26f75b. Builds on research/2026-10-20-global-config-v2-portable-and-inferred-host-graph.md.*
Track: subtrack "portable server code (server/ vs machine/)" (`block-323b766d-7ddf-4555-820a-80d82d6737f3`, instructions `block-361815ed-5750-413a-b5ab-31c5dc855144`), row "[Hubs] config_v2 split".

**User decisions (2026-10-21):**
- The demo subtree is scoped to the host composition. DemoScope gives it a filtered plugin registry, so the page and the worker agree by construction.
- Do as much of the row as context allows. Anything that needs its own design decision becomes a follow-up.

**G0 finding and decision (2026-10-21):**
- G0 measured 359 web plugins in the agent-manager bundle and 307 `available` (left out): transcript renderers, prompt-input, sidebar lists, the tab bar, surface, app-launcher, fields and more. The composition is incomplete for a standalone deploy too.
- **User decision:** complete the agent-manager composition so it is the real agent manager. It is widened **by pattern** in `entryPoints`, with negatives where needed, never as ~80 hand-listed contributors. This is gate G0b.
- Plugins whose server needs a real split (background-shells, ask-user-question, rewind, fields.secret, possibly all-conversations) join on the web side. Their server barrels stay out of the worker (they are not portable), and each gets a follow-up.

**Dedicated demo composition (user direction, 2026-10-21):**
- The host declares `agent-manager-demo`, a new composition. It `extends: ["agent-manager"]`, uses negatives for what makes no sense in a demo (push-and-exit, the file explorer, other machine-only flows), and adds demo-only plugins when needed. `agent-manager` itself stays the real standalone profile.
- **Rule:** a plugin in the demo scope whose config registrar is debt-exempted from `host-registrations-paired` would crash the use-config guard as soon as it renders. Such a plugin is either split or excluded from the demo composition; the debt exemption is not an option for it. Seen: push-and-exit's floating action crashed in the G2 build.
- **Later, a follow-up with its own design:** hosts keyed by (seed plugin, composition), so one seed can serve several demo compositions; and a multi-app `singularity-light` composition, where the scope wraps the apps layout instead of one AppEmbed.

**Natural stop point:** after G4, config is answered by the worker and config_v2's `Demo.Resource` is gone. The page server is then an empty shell that only carries the two policies. G5–G6 (the policies and the deletions) may slip to the next session without leaving a half-state.

## Context

- `/demo` renders the Agent Manager inside `DemoScope`. The page still composes two servers with `composeBrowserServers([page, hosted], page.server)` at `demo-scope.tsx:290`:
  - a **page server**: `createBrowserServer` at `demo-scope.tsx:199`, the only caller, plus config_v2's `Demo.Resource` at `config_v2/web/index.ts:20`;
  - the **worker**: `runtimeBrowserServer` + `serveOverPort`, booting the portable server barrels of the `agent-manager` composition (`bin/browser-host.composition.ts:10`).
- Problems confirmed against the code:
  1. **The page and the worker don't agree on which plugins are present.** The page renders the `singularity` web registry. The worker serves the `agent-manager` bundle. Nothing filters contributions by composition. Today, out-of-bundle reads (stats, review.code-review, sub-plugins of conversation-view, sidebar-framing, …) are hidden by the page server's `unserved` → `DemoMissingError`.
  2. **Config is answered by the page**, from the `@composition-config-layer` artifact. The `arranged` filter there (`config-git-layer-gen.ts:88-92`) drops the reorder origins, so slots fall back to `descriptor.defaults` (`demo-resource.ts:100-104`). In the worker, `ConfigGitLayer` is an `undeliveredGitLayer` and `createMemoryConfigStore()` takes no seed (`store.ts:138`). So writes would throw "no origin file" (`registry.ts:565,648`).
  3. **Every `/api` call toasts "Not available in the demo", even ones the worker serves.** The page server is the fallback and is asked first (`compose.ts:56`), and its `onUnmatched` toasts unconditionally (`demo-scope.tsx:215-229`).
  4. **Once the page server is gone, an unserved key in the worker reads "App updated — reload".** The verdict is `unknown`, because the worker's `clientBuildIdentity` is `null` (`server-core/core/resources.ts:233`; `runtime.ts:6420,6795,7057`).
- Counts after the critic's corrections:
  - 238 reorderable slots, 69 data views;
  - `config/` holds 604 `.jsonc` files: 392 base origins, 196 base overrides, 16 `@app` deltas;
  - the worker graph has 74 plugins today.

**Goal:** config is answered by the worker, the page server is deleted, and page and worker agree on the plugin set by construction.

## Decisions

1. **The demo subtree is scoped to the host composition** (user decision). A new web-sdk primitive `<PluginScope composition>` filters every slot read to contributions whose `_pluginId` is in the composition's web plugin set.
   - This is the highest rung: an out-of-composition read has no spelling inside the demo.
   - It also removes the non-config unknown-key reads, not just the config ones.
2. **The plugin set is generated, never hand-listed.** `deriveBrowserHostGraph` also returns `webPlugins` (the bundle ∩ plugins with a `web/index.ts`), `home` and `available`. The generator writes them beside the host's `start` import, so the scope and the worker serving it come from one derivation.
   - A hand subset would also trip `MissingCompanionError` (`useCompanionLookup`).
3. **Page-wide slots are declared by the slot, not escaped by the reader.** A new `SlotMeta.pageWide`. First and only user: `PaneSlots.Register`.
   - `useSyncPaneRegistry` (`pane.ts:2894`) clears and refills a module-global `registry` (`pane.ts:417,2902`). It is mounted both at the apps root and inside the embed. If scoped, the inner sync would wipe out-of-scope panes for the whole page and the two would flap.
4. **What leaves the demo is exactly `resolved.available`**, printed by gate G0.
   - Only *essential* in-demo UI that is register-only, or whose server barrel is trivially portable, joins the agent-manager row's `selectedContributors` this session. Candidates to verify: `conversation-view.prompt-input` (it imports `primitives/prompt-editor`), `conversations.conversation-ui`, `conversations.all-conversations`, `conversations-view.data-view`, `ui.sidebar-framing` + `ui.variant-region`.
   - **Deferred (product decision):** stats, stats.commits, stats.cost, review.code-review, launch-prompts, open-app, prompt-templates, push-and-exit, selection-actions, tree-disclosure. Meanwhile they simply do not render in the demo. That is correct: the agent-manager composition does not ship them.
5. **The committed layer reaches the worker through a widened `ConfigGitLayer`.** The interface becomes `document(storePath): GitLayerDocument | undefined`, replacing `hasScope`. A new portable provider plugin, `config_v2/plugins/bundled-layer`, reads it from a lazy `import.meta.glob`, mirroring `migrations/plugins/bundled-source`.
   - `browser-store` keeps only the memory `ConfigStore`. It seeds a storePath lazily, on first touch, from `ConfigGitLayer.get().document(sp)`.
   - Rejected: a second "committed" host service, and putting the glob inside browser-store (`browser-host.test.ts` could not swap it under Bun).
6. **Ship all of `config/`** (~554 KB raw against a 19 MB bundle), not a composition filter.
   - It is composition-invariant and follows the release precedent (`release/cli/run.ts:1299-1320`).
   - Lazy seeding means unused documents are inert bytes.
7. **Desktop and worker propagate through one function.** `propagateGitLayerDocument`, lifted from `propagateConfigToUser` (`config-origin-gen.ts:743-790`), is used by both the build and the memory store.
8. **Delete the whole `config-git-layer-gen` / `@composition-config-layer` pipeline in the same step as `demo-resource.ts`.**
   - `demo-resource.ts` is its only page-side consumer (verified by grep).
   - The reorder origin loss disappears with it. There is no patch to the `arranged` filter.
9. **A new config file re-addresses the host.** `moduleRecorder` records the static base of each literal `import.meta.glob` pattern as `HostInputs.globRoots`, and `hostInputsHash` lists them recursively.
   - A non-literal glob throws.
   - An old inputs record without `globRoots` returns `null`, so the host rebuilds.
10. **Pairing is enforced as a check twin: `config-v2:host-registrations-paired`.** Every `ConfigV2.WebRegister` whose *registering* plugin is in `webPlugins` must have a `ConfigV2.Register` at the same storePath in a graph member's `server/` barrel (not `machine/`).
    - Keyed by registering plugin, because reorder registers with `pluginId` overrides.
    - Exemptions come only from `exempt/index.ts`, with `kind: "debt"` and a task.
    - It shares a pure `collectConfigRegistrations` with `registrations-paired.ts`.
11. **A browser host serves a closed key set.**
    - New `SUB_ERROR_REASONS` entry `"unserved"` (no verdict, HTTP 404).
    - New runtime option `keySet: () => "open" | "closed"`.
    - `closeResourceKeySet()` in `server-core/core/resources.ts`, called by `bootBrowserHost` before `bootPluginGraph`. No option exists, so no host can forget it.
    - The client classifies `unserved` as `loader-failed`, naming the key, and treats it as terminal (no retry).
    - No PROTOCOL bump: only an in-page host sends it, and that host shares its client's build.
12. **The toast moves to a decorator on the worker server.** `toastingRefusals(server, toast)` in `demo-scope.tsx` toasts only on the worker's real 409. It uses a hardened `isUnsupportedEndpointResponse(res)` added to `infra/endpoints/core/unsupported.ts`. This fixes the spurious toast.
13. **Dead code goes:**
    - `DemoMissingError`;
    - `createBrowserServer`, its options, and the whole of `compose.ts`;
    - `bindExternalServe` / `LiveExternalServe`;
    - `allResourceDescriptors` / `onResourceDescriptorRegistered`;
    - the `browser-server/plugins/demo/web/` slot (`Demo.Resource`).

    Every one has been verified to have no other users.
14. **Heavy in-bundle registrars are deferred follow-ups, each exempted as debt:** `reports/server` (split), `infra/host/duress/server` (move the shed buffer out), and `build` / `tasks/automations` if they are in the bundle.
    - Meanwhile nothing inside the scope reads their config: they are read outside DemoScope or by needsMachine panes. The `use-config.ts:79-89` guard stays as the runtime last line.

## Design

### A. `<PluginScope>` (web-sdk/core)
- **`registry.ts`:** add `scopedReader(parent: PluginRegistryReader, plugins: ReadonlySet<string>)`. The interface is at `registry.ts:29-36`.
  - `read`: filter by `_pluginId` (stamped at `registry.ts:116`), memoised per parent array in a `WeakMap`. If nothing is filtered, return the parent array itself, which keeps the identity contract.
  - Slots with `pageWide` pass unfiltered.
  - `subscribe`: delegate to the parent.
  - `declared`: keep the in-set declarations.
  - `replace`: throw.
  - Nested scopes intersect naturally.
- **`context.tsx`:** add `PluginScope({ composition: ScopedComposition, children })`, with `ScopedComposition = CompositionIdentity & { plugins: readonly string[] }`.
  - It provides the scoped reader to `PluginRegistryContext` (`context.tsx:24`).
  - It provides `{id, home}` to `CompositionContext` (`:113`), so `useComposition()` inside the demo answers `agent-manager`.
  - Export it from the barrel.
- **`slot-declaration/core/declaration.ts:22`:** add `pageWide?: boolean` to `SlotMeta`, settable through the slot definers. Set it on `PaneSlots.Register` (`pane/web/slots.ts`).
- **Documented limits:**
  - the global `register` phase is not scopable (only error-boundary and pending-turn use it);
  - the `slot-read:` first-read marks may record a scoped first read.

### B. Generated host scope (codegen)
- **`browser-host-gen.ts:275`:** `DerivedBrowserHostGraph` gains `webPlugins`, `home` and `available`.
  - Codegen asserts `webPlugins` ⊆ every composition bundle containing the declaring plugin. This holds today through base-exclusions.
- **`generateBrowserHosts` (~:370):** also writes `plugins/apps/plugins/agent-manager/plugins/demo/core/browser-host.generated.ts`:
  ```ts
  export const browserHost = { composition, home, plugins: [...], start: () => import("@browser-host/…") } satisfies DemoHost;
  ```
  It is covered by `plugins-registry-in-sync`.
- **`browser-server/demo/core/internal/scenario.ts`:**
  - `DemoHost = ScopedComposition & { start(): Promise<{ start(): Worker }> }`;
  - `DemoScenario.host: DemoHost` becomes required (currently `host?` at `:40`);
  - the agent-manager scenario (`core/internal/scenario.ts:13-18`) becomes `host: browserHost`.

### C. Worker registrations (portability)

| Barrel | Change |
|---|---|
| `reorder/server` | `portable: true` (imports config_v2/server, plugin-id, shared/directive) |
| `primitives/data-view/server`, `view-core/server` | `portable: true` |
| `conversations/preprompts/server` | `portable: true` |
| `ui/segmented-progress-bar/server`, `tasks/task-draft-form/server`, `shell/global-action-bar/server`, `ui/tab-bar/server` | `portable: true` (register-only) |
| `config_v2/plugins/settings/server` (set-field) | `portable: true` (imports task-category/server, which is in the graph) |
| `ui/theme-engine/server` + `shell/document-head/server` | `portable: true`. Needed by the check, not the demo: theme is read outside DemoScope. If either is not clean, exempt it as debt instead. |
| `ui/variant-region/server`, `apps-core/app-rail-framing/server`, `ui/breadcrumb-separator/server`, `ui/sidebar-framing/server` | `portable: true`, only those that are in the bundle after G0 |
| `conversation-category` | move `Register` + `internal/saved-icons` from `machine/` to `server/` |
| `turn-summary`, `hibernation` | move `Register` from `machine/` to `server/` |
| `conversations/model-provider` | new portable `server/index.ts` holding the `Register`; delete `machine/` |

`host-services:provider-placement` and `config-v2:host-registrations-paired` enforce the result.

### D. Committed layer (config_v2)
- **`core/internal/config-file.ts` (new):**
  - `parseConfigFile(raw, where)` is strict: a missing `// @hash` throws, naming `where`. It parses with `jsonc-parser`.
  - Export `CONFIG_HASH_RE` once. Repoint the copies at `machine/internal/jsonc-proxy.ts:16`, `ledger/core/internal/config-ledger.ts:36`, `codegen/core/git-layer-config.ts:14`, `authored-override-seed.ts:53`, and the two checks.
- **`core/internal/store.ts`:**
  - add `parseConfigFileRelPath(rel)` (the inverse of `configFileRelPath` at `:123`; throws on anything else);
  - `createMemoryConfigStore({ propagatedFrom? })` runs `propagateGitLayerDocument` once per storePath, on the first call to any method (`proxy`, `remove`, `stamp`, `scopes`, `dropScope`, `edit`, `watch`).
- **`core/internal/git-layer.ts`:** add `CommittedFiles`, `committedDocument(sp, files)` (through `resolveGitLayer` at `:32`), `committedFilesFromMap(map)` and `propagateGitLayerDocument(doc, proxyOf)`. `propagateConfigToUser` calls `propagateGitLayerDocument`.
- **`server/internal/scope-fork.ts:59`:** `gitBacksScope` becomes `document(sp)?.scopes[appId] !== undefined`.
- **`machine/internal/repo-layer.ts`:** `document(sp) = committedDocument(sp, fsCommittedFiles(repoConfigDir()))`.
- **New `config_v2/plugins/bundled-layer/server`** (`portable: true`): `ConfigGitLayer.provide(...)`.
  - The glob is `import.meta.glob("/config/**/*.jsonc", { query: "?raw", import: "default", eager: true })`, called inside a function.
  - The pattern is root-absolute, relying on the host build's `root: <repo>` (`browser-hosts.ts:203`).
  - An empty map throws.
  - Add `"!config_v2.bundled-layer.**"` to base-exclusions (`composition/core/config.ts:179-195`) and to `config.test.ts`.
  - The graph then infers it as `hostProviders["config-v2.git-layer"]`.
- **browser-store:** `createMemoryConfigStore({ propagatedFrom: sp => ConfigGitLayer.get().document(sp) })`.
  - The read is lazy, so it happens after `assertHostServices` and before `initRegistry` reads anything.
  - Delete `undelivered-git-layer.ts` and its test.
- **`web-artifacts/core/internal/browser-hosts.ts`:** add `globRoots` to `moduleRecorder` (:147-168) and `hostInputsHash` (:88-110), per Decision 9.

### E. Unserved-key policy (Decision 11)
- `resource-protocol/core/internal/frames.ts:125`: add `"unserved"`, with docs in `protocol.ts`.
- `resource-runtime/core/runtime.ts`:
  - new `keySet` option;
  - helper `refuseUnknownKey(key, build)`, which calls `reportLoaderError` when the set is closed;
  - used at `:6420`, `:6795` and `:7057`. The `!key` branch at `:7052` stays `unknown-key`.
- `server-core/core/resources.ts`: add `closeResourceKeySet()`, which throws if called twice and is not exported from the barrel. Wire it into the runtime at `:298`.
- `server-core/core/browser-host.ts:66`: call it before `bootPluginGraph` at `:70`.
- `live-state/web/resource-error.ts` `kindOf`: map `unserved` to `loader-failed`, with a message naming the key.
- `notifications-client.ts` `isTerminalResourceError`: add `unserved`.

### F. New DemoScope
- `ScopeServer({ scenario })`:
  1. `await scenario.host.start()` → `start()` → `portBrowserServer(worker)`;
  2. write the boot line (`BOOT_LOG_CHANNEL`);
  3. `onReady(toastingRefusals(hosted.server, refusalToast(lastToastAt)))`.
- Children are wrapped in `<PluginScope composition={scenario.host}>`.
- Teardown: `served.dispose()` and `worker.terminate()`.
- Kept: `Loading`, the failure rethrow, `TransportProvider`, `NotificationsProvider`.
- Deleted: `CollectBackends` / `BackendStep` / `ContributedBackend` / `NO_BACKENDS`, `claiming`, `scopeRoutes`, `PageServer` / `buildServer`, the no-host branch.

### G. Deletions (config_v2 + config-layer pipeline at G4; the rest at G6)
- **config_v2/web:** the `Demo.Resource` contribution, `internal/demo-resource.ts`, `web/testing/index.ts`, `web/testing/empty-config-layer.ts`, `internal/composition-config-layer.d.ts`, and the `vitest.config.ts:32-37` alias.
- **`browser-server/plugins/demo/web/`:** the whole folder. `core/` is kept.
- **`scope/web/testing/index.ts`** and `scope/web/__tests__/config-v2.test.tsx`.
- **browser-server/core:**
  - `createBrowserServer`, `BrowserServerOptions`, `BrowserServe`, `BrowserServed`, `defaultOnError`;
  - `compose.ts`;
  - barrel lines 1-11, except the three interface types.
- **network/live/core:** `bindExternalServe` / `LiveExternalServe` (`serve-on.ts:1140-1265`). Keep the `External*Value` types (central uses them).
- **live-state/core:** `allResourceDescriptors`, `onResourceDescriptorRegistered`, the listeners, and the fire at `resource.ts:151`.
- **codegen:** `config-git-layer-gen.ts` + test, the exports at `codegen/core/index.ts:103-105`, and build stage 4b'' (`app-artifacts.ts:594-605`, docblock at :137).
- **web-artifacts:**
  - in `composition-modules.ts`: the config-layer specifier and its file constants;
  - in `plan.ts`: `configLayerFile*` and the registry hash (:339-361). The address becomes the registry source only;
  - in `vite-builder.ts:531-560`: keep only `index.js`;
  - drop `pipeline.ts:186`;
  - update `plan.test.ts` and `externals.test.ts`.
- **layout-harness:** the alias at `build-measurer-page.ts:78-81`.
- **`.gitignore:31-41`:** keep the lines; rewrite the comment to say they are retired outputs.

## Critical files
- `plugins/framework/plugins/web-sdk/core/{registry.ts,context.tsx,index.ts}`
- `plugins/framework/plugins/slot-declaration/core/declaration.ts`
- `plugins/primitives/plugins/pane/web/slots.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/browser-host-gen.ts`, `config-git-layer-gen.ts` (deleted)
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{browser-hosts,plan,vite-builder,pipeline}.ts`, `core/composition-modules.ts`
- `plugins/framework/plugins/browser-server/{core/,plugins/demo/core/internal/scenario.ts,plugins/demo/plugins/scope/web/components/demo-scope.tsx}`
- `plugins/apps/plugins/agent-manager/plugins/demo/{core/internal/scenario.ts,core/browser-host.generated.ts,bin/browser-host.test.ts}`
- `plugins/config_v2/{core/internal/{store,git-layer,config-file}.ts,server/internal/scope-fork.ts,machine/internal/repo-layer.ts,check/registrations-paired.ts,check/host-registrations-paired.ts,plugins/browser-store,plugins/bundled-layer}`
- `plugins/plugin-meta/plugins/composition/core/config.ts` (base-exclusions; agent-manager row at `:207-217`)
- `packages/.../resource-protocol/core/internal/frames.ts`, `resource-runtime/core/runtime.ts`, `server-core/core/{resources,browser-host}.ts`
- `live-state/web/{resource-error.ts,notifications-client.ts}`
- `infra/endpoints/core/unsupported.ts`

## Execution order and stop-gates

**G0 — Measure the scope (before any UI change).** First run `git fetch origin main && git rebase origin/main`.
- Extend `deriveBrowserHostGraph` with `webPlugins`, `home` and `available`, and make the generator print `available`.
- Run `./singularity build` (backgrounded, then `./singularity await`).
- **Stop if** `available` contains essential demo UI whose server is not trivially portable. That is a membership decision for the user, not an improvisation.
- Otherwise add the register-only essentials to `selectedContributors` (Decision 4) and rebuild.

**G1 — `PluginScope` + `pageWide`.**
- Gate: `./singularity test plugins/framework/plugins/web-sdk plugins/primitives/plugins/pane`, then `./singularity check type-check plugin-boundaries`.

**G2 — Generated host scope; DemoScope wraps `PluginScope`; `host` required.**
- The page server is still present at this gate.
- Gate: `./singularity build`, then `./singularity test plugins/framework/plugins/tooling/plugins/codegen plugins/framework/plugins/browser-server`.
- Browser check on `/demo`: the conversation renders, the prompt box is present, Home and Tasks open, no error boundary.

**G3 — Portability flags and moves (C) + the twin check (Decision 10).**
- Gate: `./singularity check config-v2:host-registrations-paired config-v2:registrations-paired host-services:provider-placement plugin-boundaries boundary-rules plugins-registry-in-sync`.
- **Stop** on any barrel that is not trivially portable: exempt it as debt plus a follow-up, never a hand list.

**G4 — Committed layer (D) + `globRoots`; config_v2's page backend deleted.**
- In the same step, delete the config_v2 part of G: the `Demo.Resource` contribution, `demo-resource.ts`, the web/testing helpers, `config-v2.test.tsx`, and the whole `config-git-layer-gen` / `@composition-config-layer` pipeline.
- The page server is left with no backends. Compose then routes every key to the worker, and only the policies remain page-side.
- Gate: `./singularity test plugins/config_v2 plugins/apps/plugins/agent-manager/plugins/demo plugins/framework/plugins/tooling/plugins/web-artifacts`, then `./singularity build`.
- Browser check on `/demo`: reorder slots show their committed order, a config write round-trips, and there is no use-config guard error.
- **Natural stop point** (see the header). Update the wiki and file the next task if stopping here.

**G5 — Unserved policy (E) + `isUnsupportedEndpointResponse`.**
- Gate: `./singularity test plugins/framework/plugins/resource-runtime plugins/packages/plugins/resource-protocol plugins/infra/plugins/endpoints` plus the live-state tests.

**G6 — DemoScope rewrite + all deletions (F, G).**
- Every step type-checks.
- Gate: `./singularity build`, `./singularity check`, `./singularity test plugins/framework plugins/config_v2 plugins/network plugins/primitives/plugins/live-state`.

**G7 — Docs, measurements, wiki, next task.**
- Wiki: `read_page` the subtrack page (an agent page). Add a dated Status entry and Measurements, update the "[Hubs] config_v2 split" checkboxes, and add "[Framework] PluginScope: the demo subtree is its host composition".
- File ONE next main task, with both page ids. No push.
- Docs: browser-server, scope and demo `CLAUDE.md`s; `config_v2/CLAUDE.md` (:346-361, 395, 594); `network/live/CLAUDE.md:1640-1645`; `web-artifacts/CLAUDE.md`; live-state; the `demo-reads.ts:63-65` comment; package.json descriptions.
- Final `./singularity build`.

## Verification
- **Unit tests:**
  - `scopedReader`: filtering by stamp, identity when nothing is filtered, page-wide slots, subscribe forwarding, nesting, `replace` throws.
  - `browser-host-gen`: `webPlugins` = bundle ∩ web barrels, file render, subset assertion.
  - The pure pairing function.
  - `parseConfigFile` and the `parseConfigFileRelPath` round trip.
  - `committedDocument`: override ⊕ origin, a stale override losing, scopes.
  - Seeded memory store, plus a parity test of memory store vs `fileConfigProxy` through `propagateGitLayerDocument`.
  - `browser-hosts.test.ts`: a new config dir changes the hash; a non-literal glob throws.
  - `runtime-unserved.test.ts`: closed → `unserved`/404, reported once each; open default unchanged.
  - live-state `unserved` classification.
  - `isUnsupportedEndpointResponse`.
- **Real-repo test** `bundled-layer/.../committed-config.test.ts`: every file parses; all 238 reorder documents have non-empty `base.items` equal to their origin (the origin-loss regression); the 16 `@app` deltas show up as scopes.
- **`browser-host.test.ts`:**
  - generalise the provider swap into a `{ serviceId: diskEntry }` table (MigrationSource + ConfigGitLayer), asserting `n - swaps` entries;
  - every registered storePath has an origin equal to the committed value;
  - a set-field round trip;
  - the storePaths the check collects for the host ⊆ worker `config-v2.scopes`;
  - `GET /api/resources/nope` → 404 `{reason:"unserved"}`.
- **jsdom tests:**
  - scope: an out-of-scope contribution does not render; an outer pane resolves after the embed mounts; `useComposition` returns the host.
  - `demo-scope.test.tsx` through the new `browser-server/core/testing` helpers `inRealmServer` + `channelHost` (`MessageChannel`; call `.start()` on both ports): value/collection render and notify; an unserved key gives `loader-failed` and an empty mismatch store; two unsupported POSTs give one toast; **a worker-served POST gives no toast**; a failing boot reaches the error boundary.
- **Browser** (`browser_*` tools after `./singularity build`):
  - `/demo`: conversation, prompt box, sidebar queue and done list, Tasks, task detail, Home;
  - reorder-driven slots show their committed order;
  - no "Not available" toast while browsing;
  - console has no `registered on web but the server has no matching ConfigV2.Register`;
  - a settings write in the demo persists for the session.
  - The exhibit: `./singularity run plugins/plugin-meta/plugins/exhibits/e2e/exhibit-shot.ts --id <demo exhibit id>`.
  - **Desktop unchanged:** screenshot `/agents` before and after; a reorder edit and a config write still work on the desktop.
- **Measurements**, reported before and after: worker bundle bytes (19.0 MB → expect ~+0.6 MB of config), modules (1,114), plugin count (74 → 75 + the newly portable barrels), and boot-to-ready from the `BOOT_LOG_CHANNEL` line in `~/.singularity/worktrees/<wt>/logs/`.

## Risks
- **The scope may drop essential UI** (the prompt input is the top suspect). Mitigated by G0's printed `available` and the G2 browser gate.
- **Global `register`-phase registries stay page-wide.** Documented.
- **Composition additions add worker roots.** The twin check then requires their `server/` barrels to be portable, which is intended but may widen G3.
- **The `ConfigGitLayer` signature change touches the desktop machine half** (`repo-layer`). Covered by registry and scope-fork tests. One semantic delta: an `@app` delta without an origin reads as false. The build always generates origins.
- **A vite glob semantics change would yield an empty map.** `document()` then throws.
- **Tests that snapshot `SUB_ERROR_REASONS` need the new entry.** Per-key report fingerprints keep report volume bounded.
- **Ordering:** the pipeline deletions only compile once `demo-resource.ts` is gone, so the two share G4.
- **Central reads** (`/api/central-resources/*`, `notifications-client.ts:1500`) still 409 and toast through the decorator. Known noise, deferred.

## Follow-ups (each needs its own decision)
1. Whether stats/commits/cost, review.code-review, launch-prompts, open-app, prompt-templates, push-and-exit (needs a server/machine split), selection-actions and tree-disclosure join the agent-manager composition.
2. Split `reports/server` (fan-out, `database/admin`, no-platform-api debt).
3. Move duress's `createShedBuffer` into a sub-plugin (4 importers).
4. Make `build` and `tasks/automations` portable (if they are in the bundle).
5. Central reads in the demo: surface them as `unavailable` like needsMachine, not as a toast.
6. Desktop `unknown-key` + `same-build`: should it also read as a loud `loader-failed`? This changes every host's classifier.
7. Lift `toastingRefusals` into `browser-server/web` once a second in-page host exists.
8. A persistent user config layer for the demo (IndexedDB/OPFS).
9. The worker as config host for a non-demo browser composition.
10. Move codegen's `nonStaleOriginProxy` onto `committedDocument`, if cheap.
11. Fold both pairing checks into one over every runtime that boots a composition.
## Outcome (2026-10-21)

All gates landed in one session (G0 → G7, plus G0b and H). `/demo` runs on the worker alone: the page server, config_v2's `Demo.Resource` and the `@composition-config-layer` pipeline are gone, and the page renders inside `<PluginScope>` over the composition the worker boots.

### Per gate
- **G0** — `deriveBrowserHostGraph` returns `webPlugins`, `home`, `available`; the generator prints `available`. Measured 74 server / 359 web / 307 left out: the composition itself was incomplete.
- **G0b** (user decision) — the agent-manager profiles share `AGENT_MANAGER_ENTRY_POINTS`, widened **by pattern** (`conversations.**`, `tasks.**`, `fields.**`, `active-data.**`, `page.**`, `code-explorer.**`, `apps-core.**`, `shell.**`, `reorder.**`, …) with negatives for adapters into other apps. `tasks.attempt-view` left `selectedContributors` (now redundant). 85 server / 653 web / 157 left out. The lead later added `ui.segmented-progress-bar.**` and `ui.tree-disclosure.**`.
- **G1** — `SlotMeta.pageWide` (set through `defineSlot({ pageWide: true })`, on `Pane.Register` only), `scopedReader`, `<PluginScope>` + `ScopedComposition`. *Deviation:* the richer slot-render constructors do not take `pageWide` yet (a page-wide render slot has no spelling).
- **G2** — codegen writes the page scope (`apps/agent-manager/demo/core/browser-host.generated.ts`, `browserHost`), `DemoHost = ScopedComposition & { start }`, `host` required, DemoScope wraps `<PluginScope>`. *Deviation:* the scope ⊆ bundle assertion was dropped — the scope is an upper bound (a page lacking a scoped plugin renders less). `pre-barrel-manifests-complete` allows each host's `scopeGenerated` file.
- **G3** — 19 barrels marked `portable: true`; conversation-category, turn-summary, hibernation and model-provider registers moved from `machine/` to `server/`. New check `config-v2:host-registrations-paired` over a shared pure `collectConfigRegistrations`. *Refinement to Decision 10:* the descriptor's owner must also be in scope (reorder's directive for the never-shipped `review/plugin-changes`).
- **G4** — Design D as planned: `config-file.ts` (`CONFIG_HASH_RE`, strict `parseConfigFile`), `ConfigGitLayer.document()`, `committedDocument` / `committedFilesFromMap` / `propagateGitLayerDocument`, lazily seeded `createMemoryConfigStore({ propagatedFrom })`, new `config_v2/bundled-layer`, `globRoots` in the host address. `config_v2/settings/server` made portable (set-field served by the worker). `reorderableSlots` moved to `reorder/server/testing` (R13).
- **H** (user direction) — new `agent-manager-demo` composition (extends `agent-manager`; minus push-and-exit, reports-investigation, sidequest-autopilot, `stats.**`, the file explorer). duress's shed engine moved to `duress/plugins/shed` (duress/server is register-only and portable); background-shells' output tail moved to `machine/` (facts now in the worker); `useConversationSubagents` skips parent-facts when subagent activity is unavailable. 6 debt exemptions removed. *Lead decision:* `build` and `reports` stay `host-registrations-paired` debt (their config is read by no scoped page).
- **G5** — `"unserved"` sub-error (404, no verdict), runtime `keySet`, `closeResourceKeySet()` called by `bootBrowserHost`; the client reads it as terminal `loader-failed`. PROTOCOL moved by itself (it is a hash of the vocabulary; pin updated) — contrary to "no PROTOCOL bump" in Decision 11, which was about intent, not the hash. `isUnsupportedEndpointResponse` added.
- **G6** — DemoScope runs only the worker, with `toastingRefusals`. Deleted: `createBrowserServer` and its types, `defaultOnError`, `compose.ts`, `DemoMissingError`, the `Demo.Resource` slot, the scope's test host, `bindExternalServe` / `LiveExternalServe`, `allResourceDescriptors` / `onResourceDescriptorRegistered`. New test helpers `inRealmServer` / `channelHost` (`browser-server/core/testing`).
- **G7** — docs: browser-server, demo, scope, agent-manager/demo, config_v2, network/live, live-state, web-sdk (`PluginScope`, `pageWide`, limits), composition (pattern-widened profiles, `agent-manager-demo`), `demo-reads.ts`.

### Measurements
| | Before (f4ec26f75b) | After |
|---|---|---|
| Worker server plugins | 74 | 110 |
| Page scope web plugins | — (whole `singularity` registry) | 650 |
| Worker modules | 1,114 | 1,917 |
| Worker bundle | 19,966,546 B | 20,782,027 B (+0.8 MB) |
| Boot to ready | — | 1,131 / 1,328 / 1,764 ms (graph 1,539, seed 91 on the slowest, busy host) |

Browser (`/demo`): conversation with header chips, prompt box and its actions, sidebar status rings, Tasks, task detail, Agents, Home; no error boundary; no "Not available" toast while browsing; a config write (group-by Status) persists for the session; reorder slots read their committed order (asserted in `browser-host.test.ts`).

### Follow-ups
Filed this session (sidequest debt tasks, G3): build `task-1792587898-4m2kk6`, reports `task-1792587903-22dhup` — still open, their exemptions remain. Resolved by H, can be closed: push-and-exit `task-1792587900-ckb59y`, duress `task-1792587902-1sr5db`, stats.commits `task-1792587905-e4lb0d`, stats.cost `task-1792587907-b7f9a1`, reports-investigation `task-1792587909-jzf6dr`, sidequest-autopilot `task-1792587911-ferzrv`.

Not yet filed (each needs its own decision):
1. **Sending a message leaks out of the demo**: `POST /api/conversations/<id>/turn` reached the real server (404, "Failed to send"). A request the scope cannot route must never reach the page's origin.
2. **Browser-host records collide across checkouts**: `~/.singularity/cache/web-artifacts/browser-hosts/<pluginPath>.json` is keyed by plugin path only, so another checkout's build overwrote this one's (`web-artifacts:map-in-sync` failed after a passing build).
3. Task detail's unserved keys in the demo (repo-info, task-workspaces / efforts / preprompts rows) — make portable or declare `needsMachine`.
4. `subagents.parent-facts` is not portable (`discovery.ts`).
5. Non-portable servers kept out of the worker: ask-user-question, rewind, fields.secret.config, all-conversations, push-and-exit (server/machine split).
6. Make `host-registrations-paired` hard for in-scope registrars (no debt for a plugin whose web half is scoped).
7. `pageWide` through the slot-render constructors.
8. Hosts keyed by (seed plugin, composition); a multi-app `singularity-light` composition.
9. Pre-existing test failures seen along the way: `web-sdk/core/load-tiers.test.ts` (stale expectations), lint RuleTester valid cases (e.g. `pane/lint/no-core-define-route-in-web`), `type-fingerprint`, `plugin-render.test.tsx` (vitest cannot resolve `@browser-host/…`).
10. Plan follow-ups 5–11 above are untouched (central reads in the demo, desktop `unknown-key` classification, lifting `toastingRefusals`, a persistent demo user layer, the worker as config host for a non-demo composition, `nonStaleOriginProxy` on `committedDocument`, folding both pairing checks).
