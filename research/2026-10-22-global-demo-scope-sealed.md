# Demo scope sealed: no leak, no gap, no debt registrar

Track: wiki *Subtrack: portable server code (server/ vs machine/)* (`block-323b766d-7ddf-4555-820a-80d82d6737f3`). Previous session: `research/2026-10-21-global-demo-config-from-worker.md` (Outcome).

## Context

`/demo` renders the `agent-manager-demo` composition inside `<DemoScope>`, served by the browser worker (PGlite). Three things are still wrong inside that scope:

1. **Leaks.** Bare `fetchEndpoint` falls back to `originTransport` (`infra/endpoints/web/internal/fetch-endpoint.ts` L145, L199). There are about 205 calls in 127 files, 105 of them in scope and 53 of those at module level. They reach the real server, and some of them **write**: "New task" in the demo creates a real task (`task-list/web/internal/tasks-data-view.tsx` `createTaskRow`). Asset URL builders bypass the transport too: `attachmentUrl`, the markdown `img-enhancer`, `codeImageUrl`.
2. **Gaps.** Coverage is checked against a hand-typed list (`demo/core/internal/demo-reads.ts`, `DEMO_READS`). A static scan found 131 referenced declarations that are neither served by the worker nor `needsMachine`. About 30 are reachable in the demo: 1 on load, 6 on normal navigation, about 25 on a click. Unserved endpoint calls are hidden by `toastingRefusals`.
3. **Debt registrars.** `build` and `reports` carry `config-v2:host-registrations-paired` debt (task-1792587898-4m2kk6, task-1792587903-22dhup).

**Exit criterion.** The demo scope admits no debt registrar and no unserved read or endpoint, and nothing inside DemoScope can reach the real server. Each of those is enforced, not just observed.

## The model

1. **Everything goes through the scope's transport.** There is no transportless fetcher, and the transport context has no default. The page server is reachable only from sanctioned exemptions.
2. **Everything the scope uses has an answer.** For every declaration (live read, endpoint, config document) that a scoped plugin references: it is served by the host graph, or it is `needsMachine`. A build guard enforces this and cannot be exempted.

## Decisions (user, 2026-10-22)

- **D1. Sending a message** is `needsMachine`: turn, retry, withdraw, conversation launch, stop. A scripted demo agent is a later task.
- **D2. `tasks.repo-info`** is `needsMachine`, and its server moves to `tasks/machine`. The Pushes block renders unlinked shas with a "no repository on this host" state; it no longer replaces the list with an error.
- **D3. Telemetry** is a sanctioned exception, and switchable later. `Transport` gets a `telemetry` field (the transport that receives its subtree's telemetry). The worker transport sets it to the page transport now; strict mode is a one-line change to `null`, which drops it. Page-wide handlers (`window.onerror`, boot, the crash beacon) belong to the page and always use the page transport.
- **D4. Persisted toasts** are ephemeral inside the demo: `POST /api/notifications` gets `needsMachine`, and `useToast` treats `unavailable` as ephemeral-only.
- **D5.** Remove Pages, Prototypes, Debug, Events and Places from `agent-manager-demo` for now (`config/plugin-meta/composition/compositions.origin.jsonc`). **Pages and Prototypes return later for cross-app integration.** Then the guard lists exactly what the page family needs (a `page/editor` split, prototypes `needsMachine`).
- **D6.** No iframe or realm. It reverses the "no iframe" decision (`research/2026-10-12-global-in-app-demo-scope.md:8`). It stays an optional packaging step for the website, later.

## Gates

### G0. Rebase and worklist
- `git fetch origin main && git rebase origin/main`.
- Write `resolveHostCoverage` (G9) first as a pure function, run it ad hoc to get the authoritative worklist, and leave it unwired until G9.

### G1. Transport primitives (`primitives/networking`)
- **Context.** `web/transport.ts`: `createContext<Transport | null>(null)`, and `useTransport()` throws without a provider. Drop `originTransport` from the barrel.
- **Page transport.** New leaf plugin `primitives/networking/plugins/page-transport/web` exports `pageTransport`.
  - New lint `networking/no-page-transport`, exemptable, with `kind: "sanctioned"` entries in each importer's own `exempt/index.ts`: web-core root provider, reports `report.ts` and `endpointErrorSink`, latency-ledger, slow-ops, app-usage, deploy analytics, boot-snapshot, health, icons/sprites, log-channels.
- **`Transport` fields.** Add `telemetry: Transport | null` (D3). Delete `assetUrl` (G4 replaces it).
- **`transportScoped`.** `transportScoped<T>(make)` returns `{ of(t) }` backed by a `WeakMap<Transport, T>`, plus `useTransportScoped`.
- **Live-state.** The pipeline (`live-state/web/use-resource.ts`) is keyed per transport through `transportScoped`, which deletes the identity special-case.
- **Root provider.** `framework/web-core/web/App.tsx` mounts `<TransportProvider transport={pageTransport}>`.
- **Testing.** `renderWithTransport` (`networking/web/testing`); `fakeFetchEndpoint` / `withTransport` (`endpoints/web/testing`); `createLiveStateHarness` mounts a provider.

### G2. The leak (`infra/endpoints`)
- **Fetcher API.** `fetch-endpoint.ts`: an internal `request(transport, …)`. Delete the bare `fetchEndpoint` export and `opts.transport`.
  - Public surface: `type FetchEndpoint`, `useFetchEndpoint()` (exists), and `fetchEndpointOver(t)` for sanctioned or store code.
  - The binding keeps the name `fetchEndpoint`, so the five call-name lint rules (`no-void-fetch-endpoint`, `no-endpoint-read`, `no-adhoc-structural-write`, `no-adhoc-turn-send`, `no-reactive-server-io`) keep working. New lint `endpoints/fetch-endpoint-binding-name` stops a renamed binding from escaping them.
- **Codemod by caller kind.**
  - Components and hooks: `const fetchEndpoint = useFetchEndpoint()`.
  - Exported helpers take `fetchEndpoint: FetchEndpoint`: `tasks/web/client.ts`, agents `patch-agent.ts`, `uploadAttachment`, the setter `api.ts` files (task-effort, task-preprompt, task-track, workspace), `task-draft-form/.../submit.ts`, `create-page-with-seed.ts`.
  - DataView descriptors become hooks: `tasks-data-view.tsx` (`createTaskRow`, `taskHierarchy`), task-deps-tree `deps-sources.tsx`, `pages-sidebar.tsx`.
  - Paste handlers: `build(file, { fetchEndpoint })`.
  - Other callers: `readNdjson(transport, …)`; `useAwaitResourceWrite()` in optimistic-mutation.
  - Migrate the `vi.mock` tests (about 16).
- **Toasts.** `useToast()` in `shell/notifications/web/internal/toast.ts`, plus D4.

### G3. Per-transport stores
- **Pending turn.** `conversations/.../pending-turn/web/internal/send.ts` and `delivery.ts` keep one store per transport (`transportScoped`).
  - New hooks: `useSendConversationTurn`, `useResendTurn`, `useDismissSentTurn` (about 13 call sites).
  - A `SentTurn` keeps the fetcher it was sent with.
  - Update the message of `no-adhoc-turn-send`.
- **Page editor.** `page/editor` `collab-session.ts` becomes per-transport. `live-state-yjs-provider.ts` takes `fetchEndpoint` and `socketUrl` at construction.

### G4. Assets
- `attachmentUrl` (paste-images core), `codeImageUrl` (`code-api/core/image-url.ts`) and the other `/api` URL builders return a branded `AssetPath`.
- `useAssetSrc(path)` returns `loading | ready{src} | unavailable{message}`:
  - On a page transport, the path itself.
  - On a browser transport, `transport.fetch`, then a blob URL, ref-counted and revoked through `transportScoped`.
  - On a `needsMachine` asset (`code.image`) with no machine, `unavailable`.
- `markdown-extensions/web/internal/img-enhancer.tsx` is the single place persisted `/api/…` markdown is converted.
- Remove the `browser:` prefix from `browser-server-transport.ts`.

### G5. Portable flips (no blockers)
- `portable: true` on `conversations/all-conversations` (fixes the on-load gap `conversations.history`), `tasks/launch-options`, `tasks/task-effort`, `tasks/task-preprompt`, `primitives/data-view/view-order` and `active-data`.
- Optional, if the guard asks: `agent-thread`, `task-subject`, `runs`.

### G6. Splits that serve the demo's own actions
- **tasks.**
  - Move `repoInfoServed` (with `needsMachine` on `tasks/core/repo-info.ts`, D2), `addTaskTool`, the auto-start reconcile warmup and relaunch-on-claude-ready from `tasks/server` to the existing `plugins/tasks/machine/`. Then mark `tasks/server` portable.
  - The 12 CRUD routes are then served by the worker, so New task, edit and dependencies run against PGlite.
  - `TaskPushes` (`task-events/web/components/task-events.tsx:142`) renders the `unavailable` arm.
- **conversations/workspace.**
  - `server/` keeps the scratch-profile registry, `workspace.catalog` and `workspace-of`, plus a new pure `parseWorkspaceSpec` (replacing `WorkspaceImpl.parseSpec` at `conversations/server/internal/lifecycle.ts:619` and `launch-option/server/internal/mutations.ts:22`). It becomes portable.
  - The `WorkspaceImpl` registry (`pathFor`, `resolvePath`, `prepare`, `launch`, `onCommit`) moves to `workspace/machine`.
  - Mark `workspace/plugins/launch-option/server` portable.
- **Conversation close.** The DB half (`markConversationClosed`) becomes portable; runtime teardown moves to machine.

### G7. `needsMachine` declarations
- **Endpoints:**
  - Conversation launch, turn, retry, withdraw and stop (D1).
  - Conversation-view `exit`, `hold-and-exit`, `drop-and-exit`, `drop-dependents`, `resume`, `rewind` and `rewind/preview`.
  - The question-relay and ask-user-question answers; summary generate; recover.
  - Notification create (D4) and `POST /api/build`.
- **Live reads:** `commits-graph.graph`, `code.commit-info`, `code.commit-files`, `build.deployment`, `config-v2.secret-meta`, `background.central-*`.
- **Callers:** each one handles `MachineResult` (tsc lists them). The composer disables send through `useMachineAvailability(postConversationTurn)`.
- Apply D5 (narrow `agent-manager-demo`).

### G8. build and reports, the debt registrars
- **build** (hibernation pattern; `build/server` has no external importers):
  - `build/server` becomes `portable: true` and keeps `IdKinds.Kind`, `ConfigV2.Register(buildConfig)`, `TaskCategory`, and `build.history`.
  - `settleDeadInflightRun` moves from the `build/plugins/run-ledger/server` barrel to a new `run-ledger/machine` barrel (not a cross-plugin `shared/` import, R10). `run-ledger/server` becomes portable.
  - Everything else moves to `build/machine`: the Trigger, routes, jobs, the terminal watcher, `onReady`. The `no-platform-api` debt on `run-terminal.ts` goes too.
  - Delete the entry in `plugins/build/exempt/index.ts`.
- **reports** (duress/shed pattern, inverted, because there are 66 external importers):
  - `reports/server` stays the portable barrel: Register, `reports.list`, the `ReportKind` / `ReportNoiseRule` slots, the types.
  - The engine moves to a new non-portable `reports/plugins/engine/server`: `recordReport`, the debounced variant, producer, buffer, process hooks, retention, backfill, investigate, uninvestigated, `ExcludeFromFork`, routes, `onReady`. Repoint about 32 importers (the 33 `ReportKind` importers do not change).
  - **Verify:** how `reports.list`'s `serveCollection` invalidates in PGlite without the producer.
  - Delete the entry in `plugins/reports/exempt/index.ts`.

### G9. Host-coverage guard on
- **Where.** New `framework/tooling/codegen/core/browser-host-coverage.ts`: `resolveHostCoverage(graph, inputs)`, called from `deriveBrowserHostGraph` (`codegen/core/browser-host-gen.ts`). Codegen and `plugins-registry-in-sync` share that derivation, so a gap fails `build` and `push`. There is no `exemptable` and no exempt hook.
- **What it checks.** S = `graph.webPlugins`. For every declaration referenced from S's `web/` and own `shared/` (and the `core/` it imports):
  - **Live reads.** A new `scanReferencedDescriptors`, over parse-resources' `buildDescriptorIndex` (exported). `parseResources` gains `folder: server | machine`, `needsMachine` and `origin`. A read is served when a member's `server/` registers the key; otherwise it must be `needsMachine`. A central-origin read must be `needsMachine` for now.
  - **Endpoints.** `endpointExports(dir)`, extracted from the routes facet into `facets/routes/core` and reading `needsMachine`, plus raw `/api/<prefix>` literals. An endpoint is served by a member's `server` route; otherwise it must be `needsMachine`.
  - **Config.** The logic of `config_v2/check/config-registrations.ts` (`collectConfigRegistrations`). There is no `needsMachine` escape for config.
- **Failure message.** The key, the reader's file:line, the serving plugin, and why it is outside the graph (not portable: which machine items block it; or not in the composition).
- **Generated reads.** Emit the derived `reads` into `demo/core/browser-host.generated.ts`. `bin/browser-host.test.ts` asserts that every one of them is in the booted `Resource.Declare` set or `needsMachine`, so the static and runtime views cannot drift.
- Clear whatever it still reports.

### G10. Deletions and docs
- **Delete:**
  - `config_v2/check/host-registrations-paired.ts`, folded into the guard. Its rule id leaves `exempt/core/rule-ids.generated.ts`, so a leftover exempt entry is a tsc error.
  - `DEMO_READS`.
  - `toastingRefusals` / `refusalToast` (`demo-scope.tsx`).
  - The "do not report" path of `EndpointUnsupportedError`: a 409 can now only mean a declared `needsMachine`.
- **Docs:** the networking, endpoints, browser-server/demo and agent-manager/demo `CLAUDE.md` files.
- **Wiki:** update the subtrack page, recording that D5 is temporary.
- **Close** task-1792587898-4m2kk6, task-1792587903-22dhup and task-1792602164-3lsppy.

## Reuse
- **Networking:** `Transport`, `TransportProvider`, `useTransport` (`primitives/networking/web/transport.ts`); `browserServerTransport`.
- **Endpoints:** `useFetchEndpoint`, `useMachineAvailability`, `implementMachine` (`endpoints/machine`), `MachineResult` / `unavailableMessage` (`endpoints/core/needs-machine.ts`).
- **Scanners:** `buildDescriptorIndex` / `parseFileBindings` (`plugin-meta/facets/resources/facet/parse-resources.ts`); `collectConfigRegistrations` / `loadConfigRegistrations`; `importClosure` (tooling/import-closure).
- **Split precedents:** hibernation (server + machine), duress/shed (engine child), config_v2/machine.

## Verification
- `./singularity check`: type-check (the `MachineResult` and `AssetPath` sweeps), eslint (`no-page-transport`, binding name), the guard through `plugins-registry-in-sync`, `exempt:manifests-valid`, and `boundaries:portable-closure` for the new portable barrels.
- `./singularity test` on `plugins/apps/plugins/agent-manager/plugins/demo`, `plugins/infra/plugins/endpoints`, `plugins/primitives/plugins/networking`, `plugins/primitives/plugins/live-state`, and pending-turn.
- **New e2e `apps/demo/e2e/no-leak.ts`.** In `/demo` it runs New task, edit title, add dependency, set effort/preprompt/workspace, paste an image, and try to send a message. It asserts:
  - every request went to the worker (a page `request` listener sees no `/api` except the sanctioned telemetry routes);
  - the composer shows "not available";
  - `query_db` on this worktree's DB has no new row in tasks, task_dependencies, notifications or attachments.
- **Browser pass with `browser_*`** on the demo task detail: Prompt card options, Pushes with unlinked shas, no "not served by this host", no error boundary.
- **Desktop smoke:** a real send, a real launch, Settings → Config, the Build button, and a report raised by a thrown error.
- Measure worker bundle size, module and plugin counts, and boot to ready, against the 2026-10-21 numbers.

## Outcome (2026-10-22)

All gates landed (G0 → G10). Build `build-1792675772-jqpit6` is green. `apps/demo/e2e/no-leak.ts` passes 13/13: no `/api` request leaves the page except the sanctioned telemetry, the page socket subscribes to no demo data, the composer shows "not available", and no row lands in the deploy's database.

### What changed
- **Leak (G1–G4).**
  - **Transport.** The context has no default, and `useTransport` throws without a provider. `originTransport` is deleted. The page server is the new leaf `primitives/networking/plugins/page-transport`, which only sanctioned importers may use (`networking/no-page-transport` lint, and inline disables are forbidden by a check).
  - **Fetcher.** The bare `fetchEndpoint` is gone. Code calls `useFetchEndpoint()`, or receives a `FetchEndpoint` or `fetchEndpointOver(t)` from its caller (~205 call sites). The `endpoints/fetch-endpoint-binding-name` lint stops a renamed binding.
  - **Per-transport state.** `transportScoped` (a WeakMap) holds one live-state pipeline per transport and one pending-turn store per transport.
  - **Assets.** `AssetPath` brand plus `useAssetSrc`; `Transport.assetUrl` is deleted.
  - **Other paths.** `no-raw-web-fetch` widened to `core/`, `shared/`, `sendBeacon` and `XMLHttpRequest`. Sockets take a path and fail on a transport with no URL.
  - *Deviation:* `Transport.telemetry` is a **boolean**, not a transport, so nothing inside a subtree can reach the page through it. Every subtree telemetry emitter checks it.
- **Gaps (G5–G8).**
  - **Portable / needsMachine.** Six plugins flipped to `portable: true`, plus about 37 more for the contributions arm (page block types, id-chip, grouped, custom-columns, improve, annotations). Turn, retry, withdraw, launch, stop, the exit family, rewind, question answers, summary generate, recover, notification create, build, commits-graph, code.commit-*, `repo-info` (unlinked shas plus "No repository on this host"), `build.deployment`, `investigateReport` and the icon sprites became `needsMachine`.
  - **tasks.** Split, and `tasks/server` is portable. Arming auto-start now emits a `tasks.autoStartArmed` trigger event that the launcher subscribes to. That adds a new trigger table and migration, and one more queue hop on the desktop.
  - **Workspace.** Split: `parseWorkspaceSpec` and the catalog are portable.
  - **Close.** Split: the portable close runs `CloseTeardown` contributions, the desktop contributes the agent stop, so the agent still stops before the request returns.
  - **build.** Split on the hibernation pattern, with `run-ledger/machine`.
  - **reports.** The engine moved to `reports/plugins/engine` (server + machine).
  - Both `host-registrations-paired` debt entries are gone.
  - **Composition.** `agent-manager-demo` now also excludes pages, prototypes, debug, events, places and automations. The seed stories use categories the worker registers (Improvements, Build, Conversations), and the seed throws on an unregistered one.
- **Guard (G9–G10).**
  - `codegen/core/browser-host-coverage.ts` runs inside `deriveBrowserHostGraph`. It checks live reads, endpoints and raw `/api` prefixes; config is checked by `config-v2:registrations-paired`. It cannot be exempted.
  - A fourth arm, the check `browser-host:contributions-covered`, catches a scoped plugin whose server contributes to a kind a graph member declares, unless the kind is marked `absentOnHost` (Trigger, ReportKind).
  - The generated `hostReads` is asserted by the boot test.
  - Deleted: `host-registrations-paired`, `DEMO_READS`, `toastingRefusals`, and the "do not report" path of the 409.

### Measurements
| | 2026-10-21 | now |
|---|---|---|
| Worker bundle | 20,782,027 B | 22,838,641 B (+2.06 MB) |
| Worker modules | 1,917 | 2,316 |
| Worker server plugins | 110 | 144 |
| Page-scope web plugins | 650 | 637 |
| Boot to ready (warm) | 1.1–1.8 s | 1.12–1.43 s |
| Guard cost per derivation | — | ~4.5–5 s |

### Open
1. **Writes in the demo do not render.** They reach PGlite with a 200, but live reads never recompute, because the worker has no change feed. Needs a portable `database/change-feed`: a LISTEN host service, and `node:async_hooks` / `node:crypto` out of the producer and the triggers.
2. **Guard cost.** About 5 s per derivation, paid by both `build` and `plugins-registry-in-sync`.
3. **Guard blind spots.** Raw `/api` prefixes registered at runtime (the asset mirror), and `needsMachine` that arrives through a spread (fails loudly). `SharedWebSocket` and `ReconnectingEventSource` are still exported without a transport.
4. **Minor demo copy.** The context-card "not available" notice sits over the transcript, and the prerequisite popover says "tasks target main from an agent worktree".
5. **Pages and Prototypes return later** for cross-app integration; the guard will list what they need.
6. **Not run:** a desktop smoke of a real send or launch.
