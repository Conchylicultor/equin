# Config live values: optional params, "no subject yet", and preloading a param'd value

## Context

Resources page item 9 (and the value half of item 7's phase-3 deferrals). Four config resources are
still on the old live-state factories — `config-v2.values`, `config-v2.scopes`, `config-v2.conflicts`,
`config-v2.tiers` (10 files in the `no-legacy-resource-spelling` allowlist). Three things block them:

1. **Optional params.** `values` / `conflicts` / `tiers` take `{ path, scopeId? }`. `liveValue`'s `params`
   derives every name as a required string, so an optional `scopeId` has no spelling.
2. **Config's own boot path.** Config hydrates N tuples per key (every `{ path }`, every
   `{ path, scopeId }` with its own config, and the scopes map) through its own `Core.Boot` task and
   `GET /api/config-v2/snapshot`, and is the last user of `resident`. The boot snapshot and `preload`
   only know ONE default tuple per key, and `liveValue` forbids `preload` beside `params`.
3. **Lock-step notifies.** `registry.ts` notifies values, conflicts and tiers with three copies of the
   same fan-out (base tuple + every known un-forked scope).

Same params spelling, other half: four value readers have no id yet and subscribe a sentinel `""` tuple
(`active-data.bindings`, `jsonl-events` in `workflow-node-pane.tsx`, `subagent-activity` + `jsonl-events`
in `use-subagent-statuses.ts`, `config-v2.secret-meta` in the Apple / Google wizards). Collections have
`useLiveRow(c, null)`; values have nothing.

Each gets one spelling, for every value — not a config special case.

## What the investigation found

- **The sentinel tuples cost real server work.** `jsonl-events {id:""}` and `subagent-activity {id:""}`
  run `whileSubscribed` for id `""` (a transcript watcher / a `watchPaths` room for no conversation);
  `active-data.bindings` runs a query `WHERE conversation_id = ''`; the wizards' `{ path: "" }` on the
  legacy `config-v2.values` makes the loader THROW (`no descriptor registered for resource path ""`) —
  a `sub-error` per mount while the registration is missing.
- **`resident` / `"boot-and-keep"` do not keep a tuple nobody has observed yet.** `hydrateResource` →
  `setQueryData` builds the query with the client's default options (`gcTime` 5 min) and the query
  constructor schedules its GC (query-core 5.99 `query.js:34`). `gcTime: Infinity` is applied only by
  `useResource`, i.e. once an observer mounts. So a config document hydrated at boot and first read more
  than 5 minutes later (the sidebar opened an hour in — the exact case the `resident` comment cites) is
  gone: pending, `useConfig` answers `defaults`, then flips. Same for every `"boot-and-keep"` value.
- **A param'd preload would trip L2.** `live-state-snapshot` treats every preloaded key as a
  single-tuple (`"{}"`) resource: `recomputeResource(key)` at boot for any key without a persisted
  read-set (it would run config's loader with `{}` and throw), and `shouldPersist(key)` would persist
  every tuple of a DB-backed one onto one `{}` row. Both preloaded-key sets (boot-snapshot's
  `boot-keys.ts`, L2's `persist.ts`) filter the same way today.
- **`config-v2.scopes` is also what "the server registered this path" should come from.** Config's boot
  task records `setKnownServerPaths(Object.keys(global))` for `useConfigResult`'s half-registration
  assert. A module-level set filled by a boot task is exactly the second hydration path this item
  deletes.
- The mapped `recomputeOn` form forces the upstream's loader (the runtime computes the value for any
  `map` edge, `needValue`), so it is the wrong tool for "tiers follows values"; the bare form
  (`toSubscribed`) never forces it.

## Design

### 1. Optional params — `params: ["path", "scopeId?"]`

A trailing `?` declares an optional param, mirroring TS: `LiveValueParams<["path","scopeId?"]>` =
`{ path: string; scopeId?: string }` (key remapping over the tuple; typechecked in a scratch program,
assignable to `Record<string, string>` without `exactOptionalPropertyTypes`). The descriptor stores
the bare names (`params: ["path","scopeId"]`) and `optionalParams: ["scopeId"]`.

- **One tuple per logical read.** `useLive` canonicalizes a value's params before they reach
  `useResource`: undefined-valued keys are dropped, so `{ path, scopeId: undefined }` and `{ path }`
  are the same tuple (the wire, `paramsKey` and React Query's `hashKey` already agree on that because
  JSON drops `undefined`; canonicalizing makes it explicit and gives one memo key). An untyped caller
  missing a required name or passing an undeclared one throws.
- Server: the loader, `notify`, `whileSubscribed`, `revalidate` and `recomputeOn` mappers all see `P`
  with the optional key; `serveValue`'s `notify` canonicalizes the same way.

### 2. No subject yet — `useLive(value, null)`

For a param'd value, `params` may be `null`: "there is nothing to read yet". The read is
`{ pending: true, error: null }` for as long as it is `null`, and it:

- subscribes nothing, makes no HTTP read and no cold-start prime (no server work at all);
- does **not** count as a pending mount (the page is not waiting on the server for it).

Why `pending` and not a new state: a value whose subject is not known yet is not known yet, and every
one of the four sites already renders it as pending (loading / `{ kind: "pending" }` / a pending
binding handle) — only without the dead subscription now. A caller that knows "never" (a legacy log
with no message identity) already branches on its own `null`. No placeholder is invented (no `T`
exists to stand in), and `ResourceResult<T>` stays the one read type — no consumer churn.
A param-less value takes no argument (tsc), so `null` is only spellable where a subject exists.

Mechanics: `useResource(resource, params: P | null)` — `null` is the substrate's skip: every hook still
runs (stable order); the observe effect, prime, pending-mount and slow-report effects no-op; the query
sits on one reserved disabled key with no data; `refetch` is a no-op. `useResource` is banned outside
the substrate by the lint, so the only public spelling is `useLive(value, null)`.
**`useLiveRow(c, null)`** switches to the same skip (it read the shared `{ ids: "" }` tuple, which
counted as a pending mount until its `[]` landed): still `found: false` from the first render, now with
no subscription.

### 3. Preloading a param'd value — `preload` + `serveValue({ preloadParams })`

`liveValue(key, { params, preload: "boot" | "boot-and-keep" })` becomes legal. The server — not the
declaration — knows which tuples exist at boot, so `serveValue` must enumerate them:

```ts
serveValue(configValues, {
  source: "external",
  loader,
  preloadParams: () => [...every { path }, ...every { path, scopeId } with its own config],
});
```

- **Typed pairing (rung 2):** a param'd preloaded `LiveValue` carries a type flag; `serveValue`
  requires `preloadParams: () => P[] | Promise<P[]>` for it and forbids it otherwise. A runtime assert
  in `serveValue` covers untyped callers (and a preloaded param'd value served without it).
- **Declare:** `Resource.Declare`'s payload gains `preloadParams?` (projected, like `preload`).
- **Boot snapshot** (`infra/boot-snapshot`): for a declaration with `preloadParams`, enumerate the
  tuples and load each through `loadResourceByKey(key, params)` (the loader stays the only source of
  the value); a failed tuple is omitted. Response gains
  `tuples: Record<key, { params, value }[]>` beside `resources` (default tuples, unchanged). The client
  hydrates each tuple. Timings per key sum the tuples.
- **L2 excludes them:** its preloaded set is "preloaded AND default-tuple" (`preloadParams ===
  undefined`) — never persisted, never force-recomputed at `{}`.
- `defaultParams` stays for default-tuple preloads only.

### 4. `"boot-and-keep"` keeps every tuple, observed or not

`hydrateResource` registers `queryClient.setQueryDefaults([key], { gcTime: Infinity })` for a
`"boot-and-keep"` descriptor before seeding (query defaults match by key prefix, so every tuple of the
key — hydrated, observed or later subscribed — is built with no GC timer). `useResource`'s own
`gcTime: Infinity` stays for tuples a tab subscribes without a hydrate. `resident` is deleted
(`ResourceDescriptor.resident`, `ResourceDescriptorOptions.resident`, the `useResource` branch).

### 5. Config on `liveValue`

Core (`config_v2/core/internal/resource.ts`), exported names follow the migrated two
(`configConflictLocations`, `configModifiedCounts`):

| Key | Declaration | Serve |
|---|---|---|
| `config-v2.values` | `configValues`: `params: ["path","scopeId?"]`, `preload: "boot-and-keep"` | external; `preloadParams` = every `{path}` + every `{path, scopeId}` with own config (the old snapshot's enumeration) |
| `config-v2.scopes` | `configScopes`: param-less, `preload: "boot-and-keep"` | external; payload lists **every registered storePath** → scope ids (`[]` when none) |
| `config-v2.conflicts` | `configConflict`: `params: ["path","scopeId?"]` | external; `recomputeOn: [configValuesServed]` |
| `config-v2.tiers` | `configTiers`: `params: ["path","scopeId?"]` | external; `recomputeOn: [configValuesServed]` |

- **Lock-step becomes one fan-out.** `notifyValues` / `notifyConflicts` / `notifyTiers` collapse into
  `notifyDocument(storePath, scopeId)`: modified-count refresh, the values fan-out (base tuple + every
  known un-forked scope), and `refreshConflictLocations`. Conflicts and tiers follow through bare
  `recomputeOn` (every subscribed tuple recomputes on any values notify — the detail pane's one or two
  tuples, each a 3-`stat` memo hit; push drops a byte-identical result). A new writer cannot notify
  values and forget the other two.
- **Scopes map lists every registered path.** `useConfigResult`'s half-registration assert reads
  `path in scopes.data` (settled only), replacing `server-paths.ts` (`setKnownServerPaths` /
  `useKnownServerPaths`).
- **`useConfigResult`:** `useLive(configScopes)` (no `select` — derive `inScope`; the map changes only on
  a fork / unfork / first scoped write), `useLive(configValues, { path })`, and
  `useLive(configValues, inScope ? { path, scopeId } : null)` — the scoped read is now a real skip
  instead of a second observer on the global tuple. Semantics unchanged: a scoped read not settled yet
  falls back to the global value.
- `useScopeMembership`, `ScopeTabs`, `use-tiers.ts`, `use-conflicts.ts`, `config-detail.tsx`, the two
  Apple wizard files: `useLive` over the new declarations.
- **Deleted:** `web/internal/boot.ts` (the `Core.Boot`), `web/internal/server-paths.ts`, the
  `configSnapshot` endpoint + `snapshot-handler.ts` + `getConfigSnapshot`, `resident`. The lint's
  Item 9 group empties.

### 6. The four sentinel sites

`useLive(v, id === null ? null : { id })` at each:
`use-active-data-binding.ts` (handle unchanged: `pending`, `enabled: false` without identity),
`workflow-node-pane.tsx`, `use-subagent-statuses.ts` (both reads),
`apple-provider-row.tsx` / `apple-setup-pane.tsx` / `google-setup-pane.tsx` (`reg ? { path } : null`
for `configSecretMeta` and `configValues`).

## Critical files

- `plugins/network/plugins/live/core/internal/live-value.ts` (+ test) — optional names, preload with params, type flag
- `plugins/network/plugins/live/web/internal/use-live.ts` (+ `web/__tests__`) — canonical params, `null`, `useLiveRow` skip
- `plugins/network/plugins/live/shared/compile-value.ts`, `server/internal/serve-value.ts` (+ tests) — `preloadParams` (typed + assert), canonical `notify`
- `plugins/primitives/plugins/live-state/web/use-resource.ts`, `core/resource.ts` — `null` skip, `setQueryDefaults`, `resident` deleted
- `plugins/framework/plugins/server-core/core/resources.ts` — Declare payload `preloadParams`
- `plugins/infra/plugins/boot-snapshot/{core/endpoints.ts,server/internal/*,web/internal/boot.ts}`
- `plugins/database/plugins/live-state-snapshot/server/internal/persist.ts` (the L2 preloaded set)
- `plugins/config_v2/{core,server,web}/…`, `plugins/config_v2/plugins/settings/web/…`
- The four sentinel sites; `plugins/network/plugins/live/lint/index.ts` (Item 9 group removed)
- Docs: `network/live/CLAUDE.md`, `config_v2/CLAUDE.md`, `live-state/CLAUDE.md`, `infra/boot-snapshot/CLAUDE.md`

Files Task 1 already touched and this one touches again: `server-core/core/resources.ts`,
`live-state/core/resource.ts`, `network/live/CLAUDE.md`, `live-state/CLAUDE.md` (additive only).

## Verification

- Unit: `live-value.test.ts` (optional names → `P`; `preload` beside `params` legal; `@ts-expect-error`
  for a missing required name, for `null` on a param-less value); `serve-value.test.ts` (`preloadParams`
  required for a preloaded param'd value, forbidden otherwise — tsc and runtime; canonical `notify`);
  `use-live` jsdom tests (a `null` read subscribes nothing, is pending, is not a pending mount; flipping
  `null` → params subscribes; `{ path, scopeId: undefined }` ≡ `{ path }`; `useLiveRow(c, null)` makes no
  sub); `hydrateResource` of a `"boot-and-keep"` descriptor survives past the default `gcTime` with no
  observer (fake timers); boot-snapshot assembly with an enumerated key; L2 excludes it.
- `./equin test` on network/live, live-state, optimistic-mutation, resource-runtime, server-core,
  boot-snapshot, live-state-snapshot, config_v2 (+ settings), active-data, the subagents / workflow
  plugins; `./equin check` via the build.
- Deploy, then e2e on the deploy: boot paints config values on the first frame (theme / sidebar
  framing — no default→value flash, screenshot), the boot-snapshot response carries the config tuples
  and no `/api/config-v2/snapshot` request is made; Settings → Config: edit a field, it persists (reload)
  and propagates live to a second tab; a per-app (scoped) config resolves scoped on first paint; the
  scope tabs, tier stripes and conflict banner render. Boot-snapshot timing before/after (its `timings`).
- Logs: no `sub-error` for `config-v2.*`, no loader throws at boot (L2 recompute), no `""` tuples
  subscribed (debug snapshot).

## Design review (adversarial, before implementation) — decisions

Full findings: an Opus reviewer, 1 blocker, 10 should-fix, 12 nits. What changes in the design:

- **B1 — ~300 runtime flights, each capturing a Postgres watermark, on the first-paint path.** Every
  runtime flight runs `captureWatermark()` (one `SELECT pg_snapshot_xmin(…)`), and `loadResourceByKey`
  goes through the flight path. **Decision:** a runtime read `loadResourceTuples(key, params[])` —
  the loader only (`timedLoad`: schema parse + `loader` span), sequential per key, no flight, no
  watermark, each tuple settled on its own (`{ params, ok, value | error }`). The boot snapshot uses it
  for enumerated keys. (Skipping the watermark for every external flight is the broader fix; it
  changes every external frame's Rule-B′ stamp and is left as a follow-up.)
- **S1 — dropping `select` makes `false`-while-pending a `no-pending-data-collapse` hit.** Decision:
  `useConfigResult` with a `scopeId` is `pending` while the scopes map is (honest; the window is
  unreachable after a successful boot now that the map is preloaded and kept). `useScopeMembership`
  gets the same treatment in whatever form its callers allow (decided in code).
- **S2 / S3 — two "absent" spellings, canonicalize at the substrate.** An optional param is present iff
  it is a non-empty string: `canonicalParams` (live-state core) drops `undefined` and `""` for declared
  optional names (and `undefined` for any key), applied at `useResource`'s entry (covers `observe`,
  the HTTP fallback URL, the prime and the query key), `hydrateResource`, and `serveValue`'s `notify`.
  Descriptors carry `optionalParams`.
- **S4 — fifth sentinel site:** `push-and-exit-button.tsx`'s `{ attemptId: … ?? "" }`. Added. Plus a
  rung-3 lint, `live/no-sentinel-param`: a `useLive` params object literal whose value is `""`, or
  `x ?? ""` / `x || ""`, or a conditional with a `""` branch, is an error.
- **S5 — `null` is "not arrived yet", not "never".** The wizards' missing registration is a settled
  answer: they throw (as `useStorePath` does for a descriptor with no web registration).
  `workflow-node-pane.tsx` is checked the same way. Rule documented in `network/live/CLAUDE.md`.
- **S6 — silent drops.** A failed tuple (or default-tuple fallback) is reported through the server
  error reporter; the web hydrate loop isolates each entry and reports a bad one.
- **S7 — "push drops a byte-identical result" was wrong** (the runtime broadcasts every recompute).
  **Decision:** a params-only runtime edge, `DependsOnEntry.mapParams`, which does not count as a
  value-aware downstream (so it never forces the upstream loader); `compileRecomputeOn` emits it for the
  mapped form (every existing mapped `recomputeOn` stops forcing its upstream too). Conflicts and tiers
  use the identity map `{ value: configValuesServed, params: (p) => p }` — the exact lock-step.
- **S8 — one source for the scopes map and the preloaded tuples:** both read `scopeMembers` (+ every
  `descriptorByPath` key), and both await `registryReady`.
- **S9 — re-render cost of the flat map without `select`:** accepted (a fork / unfork / first scoped
  write is a rare user action; after Task 1's tracking spans, a reconnect already re-renders every
  reader through its own values sub-ack). Recorded, not measured unless the e2e shows a hitch.
- **S10 —** `mail/threads/e2e/mailbox-tabs-verify.ts` polls the deleted snapshot endpoint → it reads
  `GET /api/resources/config-v2.values?path=…` instead.
- Nits taken: `skipToken` on a per-key idle key and no `q.refetch` on the skip arm (N1); document the
  pending-mount exclusion (N2); corrected L2 reasoning (N3 — for an external value `recomputeResource` is
  a version bump; the exclusion matters for a DB-backed param'd preload and the `"{}"`-only L2 rows);
  `preloadParams` rides `Resource.Declare` from `serveValue`, the runtime `Resource` is untouched, and
  `serveValue`'s runtime assert is the pairing check (N4); `setQueryDefaults` registered by both
  builders — `hydrateResource` and `useResource` — before any query is built (N6); sequential tuple
  loads (N8). Not taken: one `{ key, params, value }` list (N5 — `bell-filter.ts` reads
  `resources[key]`; the additive `tuples` keeps it), all-optional params (N7), base/scoped split (N10).

## Report (2026-09-27)

Built in branch `att-1790510418-62ex` on top of Task 1 (`research/2026-09-27-global-live-substrate-gaps.md`), uncommitted,
awaiting review. Deployed: http://att-1790510418-62ex.localhost:9000 — receipt `status: ok`, build
`f14d715a4-1790539331067` (every check green; the build after the framework increment and its review fixes).

### What changed and why

1. **Optional value params — `params: ["path", "scopeId?"]`** (`network/live` `liveValue`). A trailing `?` derives an
   optional key in `P`; the descriptor records bare names in `params` and the optional ones in `optionalParams`.
   **One tuple per logical read:** `canonicalParams` (a new leaf, `packages/canonical-params` — ONE copy for both ends
   of the wire) drops an `undefined` param, and a `""` for a declared-optional one. Browser: `useResource`'s entry
   (through a memo keyed by the canonical JSON, so the effects depend on `p` itself — the three `JSON.stringify(p)`
   deps and their positional `eslint-disable`s are gone), `useResourceAcks`, `hydrateResource`,
   `useOptimisticResource`'s own keys. Server: the resource runtime itself (see "Framework changes"), and
   `serveValue`'s `preloadTuples` (which bypasses the runtime).
2. **No subject yet — `useLive(value, null)`** (param'd values only, tsc). The substrate's skip is
   `useResource(desc, null)`: every hook still runs, but no subscription, no HTTP read or prime (React Query `skipToken`
   on a per-key skip key), no pending-mount count; the result is `{ pending: true, error: null }`. `useLiveRow(c, null)`
   uses the same skip (it no longer reads the shared `{ ids: "" }` tuple). Rule, documented: `null` means "not arrived
   yet"; a subject that will never arrive is a settled answer the caller renders or throws on.
3. **Preloading a parameterized value.** `liveValue(key, { params, preload })` is legal and branded
   (`preloadsParams: true`, `LivePreloadedParamValue`); its `serveValue` must pass `preloadParams: () => P[]` (tsc via
   the overloads, plus a serve-time throw for untyped callers; any other value may not pass it). `serveValue` turns it
   into a `preloadTuples` loader on the `Resource.Declare` payload: canonical params, each tuple through the resource's
   own `load` (loader + schema parse — no flight, no commit-watermark DB query), sequential, settled per tuple. The boot
   snapshot ships them under `tuples[key]`; the client hydrates each (per-entry isolation, failures reported); L2
   (`live-state-snapshot`) excludes enumerated keys from its persist / boot-recompute set.
4. **`"boot-and-keep"` keeps every tuple.** `hydrateResource` registers `setQueryDefaults([key], { gcTime: Infinity })`
   before seeding: query-core builds a `setQueryData` query with the client defaults and arms its 5-minute GC timer in
   the constructor, so `useResource`'s own `gcTime` (applied when an observer mounts) came too late for a tuple nobody
   opened within 5 minutes of boot — the exact case config's `resident` flag claimed to cover, and did not.
5. **Config on `liveValue`.** `configValues` (`{ path, scopeId? }`, `preload: "boot-and-keep"`, preloadParams = every
   registered `{path}` + every `{path, scopeId}` in `scopeMembers`), `configScopes` (param-less, `boot-and-keep`, now
   lists EVERY registered path, `[]` when unscoped), `configConflict` and `configTiers` (`{ path, scopeId? }`), all
   external. **Lock-step:** the three `notifyValues` / `notifyConflicts` / `notifyTiers` copies became one
   `notifyDocument(storePath, scopeId)` that derives the moved tuples once and notifies all three per-document values,
   plus the two aggregate refreshes. **Deleted:** config's `Core.Boot` task, `GET /api/config-v2/snapshot` +
   `snapshot-handler.ts` + `getConfigSnapshot`, `web/internal/server-paths.ts`, and `resident` (descriptor field,
   factory option, `useResource` branch).
   - `useConfigResult`: reads `configScopes` (no `select`); a non-member scope's read is skipped (`null`); a member's
     unsettled document falls back to the global one; with a `scopeId` and the map unknown it is `pending` (memoized;
     `stale` only when a map was known). The half-registration assert reads the map **as this page first saw it**
     (a later push dropping a path is deploy skew, not a wiring bug).
   - `useScopeMembership` returns `ResourceResult<boolean>`; its four theme callers render pending honestly
     (`ScopedAppTheme` emits no block, `ScopeReporter` reports pending, the customizer / quick-theme panels show
     Loading — or the last-known answer under a transient error).
6. **Sentinel `""` reads removed** (`useLive(v, null)`): `active-data.bindings`, `jsonl-events` (workflow node pane —
   no conversation now renders an explicit message), `subagent-activity` + `jsonl-events`, `attempt-work`
   (push-and-exit), `edited-files` (`useEditedFiles(id: string | null)`, file-peek pane), `config-v2.secret-meta` +
   `config-v2.values` (Apple/Google wizards: a missing registration now throws; `secret-renderer` outside a config
   field reads nothing). `secret-meta`'s loader now throws on an unknown path. New rung-3 lint
   `live/no-sentinel-param` rejects a `""` stand-in in a `useLive` / `useLiveRow` / `useOptimisticResource` params
   argument.
7. The lint's Item 9 allowlist group is empty and removed; `mailbox-tabs-verify.ts` polls
   `GET /api/resources/config-v2.values?path=…` instead of the deleted endpoint.

### Framework changes (approved by the user for this session) — review these first

All under `plugins/framework/`. Task 1 changed the same two files (`server-core/core/resources.ts`,
`resource-runtime/core/runtime.ts`); this task's hunks are the ones named here.

1. **`server-core/core/resources.ts` — `Resource.Declare` payload gains `preloadTuples?`** (plus its projection).
   Set only by `network/live`'s `serveValue` for a parameterized value declared `preload`; the boot snapshot calls
   it to load the enumerated tuples, and L2 excludes a Declare that carries it. Additive and optional.
2. **`resource-runtime/core/runtime.ts` — optional params canonicalized by the runtime.** `ResourceContract` /
   `ResourceDefinition` / the registry entry gain `optionalParams?` (threaded from the shared descriptor by the
   two-arg define; the flat one-arg forms reject it — tsc). `canonicalTuple` (= the shared `canonicalParams`) is
   applied where params enter: the WS dispatcher for every op (`sub`, `sub-batch` entries, `unsub`, `sub-acks`; a
   non-canonical frame is reported once per key, since every echo carries the canonical tuple), the HTTP read,
   `scheduleNotify` (the funnel for `notify`, the change feed, `triggerResourcePush`, the L2 recompute), each
   `cascadeDownstream` derived tuple, `loadResourceByKey`, `measureSubscribeCycle`, and the `Resource.load` handle.
   The runtime now imports the leaf `packages/canonical-params/core` (its acyclic rule allows leaves). New suite
   `runtime-optional-params.test.ts`.
3. **Docs:** `resource-runtime/CLAUDE.md` (optional params, leaf import, test index; config no longer a direct
   caller), `server-core/CLAUDE.md` (the Declare payload; config no longer a direct caller).
4. **Build-regenerated:** `web-sdk/core/web.generated.ts`, `web-sdk/CLAUDE.md` (config_v2 has no `Core.Boot` any
   more; changed web dependsOn lists).

### Files touched

- packages/canonical-params (new leaf plugin): `package.json`, `CLAUDE.md`, `core/index.ts`,
  `core/internal/canonical-params.ts` (+ test)
- live-state: `core/{resource.ts, index.ts}`, `web/use-resource.ts`, `CLAUDE.md`
- network/live: `core/internal/live-value.ts` (+ test), `core/index.ts`, `web/internal/use-live.ts`,
  `web/__tests__/use-live.test.tsx`, `server/internal/serve-value.ts` (+ test), `central/internal/serve-value.ts`,
  `lint/{index.ts, no-legacy-resource-spelling.ts,
  no-sentinel-param.ts (new), no-sentinel-param.test.ts (new)}`, `CLAUDE.md`
- optimistic-mutation: `web/internal/use-optimistic-resource.ts`
- **framework:** `server-core/core/resources.ts`, `server-core/CLAUDE.md`, `resource-runtime/core/runtime.ts`,
  `resource-runtime/core/runtime-optional-params.test.ts` (new), `resource-runtime/CLAUDE.md`; build-regenerated
  `web-sdk/core/web.generated.ts`, `web-sdk/CLAUDE.md` (see "Framework changes").
- infra/boot-snapshot: `core/endpoints.ts`, `server/internal/{boot-keys,handle-boot-snapshot}.ts`,
  `web/internal/boot.ts`, `web/__tests__/boot.test.ts` (new), `CLAUDE.md`
- database/live-state-snapshot: `server/internal/persist.ts`
- config_v2: `core/{index.ts, internal/resource.ts, internal/endpoints.ts}`, `server/{index.ts, internal/resource.ts,
  internal/registry.ts}`, deleted `server/internal/snapshot-handler.ts`, `web/internal/{boot.ts, server-paths.ts}`,
  `web/{index.ts, internal/use-config.ts, internal/use-scope-membership.ts}`, `plugins/settings/web/{components/
  config-detail.tsx, components/scope-tabs.tsx, internal/use-conflicts.ts, internal/use-tiers.ts}`,
  `e2e/config-live-values.ts` (new), `CLAUDE.md`
- ui/theme-engine: `web/theme-selections.tsx`, `web/components/theme-injector.tsx`,
  `plugins/theme-customizer/.../theme-customizer.tsx`, `plugins/quick-theme/.../quick-theme-panel.tsx`
- sentinel sites: `active-data/web/internal/use-active-data-binding.ts`, `.../subagents/web/internal/use-subagent-statuses.ts`,
  `.../workflow/web/components/workflow-node-pane.tsx`, `.../push-and-exit/web/components/push-and-exit-button.tsx`,
  `.../code/web/use-edited-files.ts`, `.../file-pane/web/file-peek-pane.tsx`, apple `apple-provider-row.tsx` /
  `apple-setup-pane.tsx`, google `google-setup-pane.tsx`, `fields/secret/config/{web/components/secret-renderer.tsx,
  server/internal/resource.ts}`
- comments: `reorder/web/internal/use-reorder-config.ts`, `chord/piano/web/internal/use-sound-mix.ts`;
  `mail/threads/e2e/mailbox-tabs-verify.ts`
- Task 1 files touched again: `server-core/core/resources.ts`, `live-state/core/resource.ts`, `network/live/CLAUDE.md`,
  `live-state/CLAUDE.md`, `network/live/shared/compile-value.ts` (additive only).

### Verification

- `./equin check type-check`: ok. `./equin build` (every check): ok — see the receipt below.
- `./equin test` on network/live, live-state, resource-runtime, server-core, optimistic-mutation, config_v2,
  boot-snapshot, live-state-snapshot, active-data, theme-engine, fields/secret, conversation-view/code: all pass
  (last full run: bun 75 files, vitest 13 files; after the review fixes: bun 50 + vitest 12 files on the touched
  subset). New tests: `canonicalParams`; `liveValue` optional names / bad names / param'd preload brand / central
  refusal; `serveValue` preloadParams pairing (tsc + throw), canonical + settled `preloadTuples`, canonical `notify`
  over a real socket; `useLive` null skip (no observe, not a pending mount, refetch inert), one tuple for three
  spellings, `boot-and-keep` hydrated tuple outlives the default gcTime with no observer (fake timers); the
  `useLiveRow(c, null)` test rewritten (no subscription); boot hydrate isolation; the lint rule.
- **E2E** `plugins/config_v2/e2e/config-live-values.ts` on the deploy — 18/18: the boot snapshot ships all 368 config
  documents (321 base + 47 scoped) canonically, `config-v2.scopes` preloaded; `/api/config-v2/snapshot` → 404 and no
  page asks for it; `?scopeId=` reads the base; a scoped document reads back as preloaded; a write (the global action
  bar's `enabled`) propagates live to two other contexts; **first paint after the write never shows the bar, not for
  one frame** (MutationObserver from before any script); re-enable propagates; Settings → Config opens a per-app
  scoped descriptor with its Base / Agent Manager / Mail / equin tabs; no config / boot-snapshot console errors.
  The harness reverted the write. Re-run on the final build (`f14d715a4-1790539331067`): 18/18.
- **Regression e2e** (Task 1's `network/live/e2e/reconnect-after-gap.ts`, which drives `useResource` through a
  dropped socket) on the final build: 7/7.
- Framework increment: `./equin test` on resource-runtime, network/live, live-state, optimistic-mutation,
  packages/canonical-params, server-core — all pass (bun 50 files, vitest 10). No "non-canonical params" report,
  no config / boot-snapshot report on the deploy after the e2e runs.
- Deploy inspection: config documents' boot work 5.5 ms, scopes 1.9 ms; config's share of the boot snapshot 124 KB
  (+17 KB scopes) vs 107 KB for the old endpoint (the snapshot's 5 MB is the tree resources, item 3); no sub-errors, no
  `""` tuples in `live-state.jsonl`, no crash reports for config or the boot snapshot.

### Review findings and what I did

Design review (before implementation): see "Design review — decisions" above; two were reversed while
implementing, for a framework-scope reason (`plugins/framework/CLAUDE.md`): **B1** — no runtime
`loadResourceTuples`; the tuples load through the resource's own `load` via `preloadTuples` on the Declare
payload (same effect: no flight, no watermark query). **S7** — no runtime `mapParams` edge; the lock-step is one
explicit fan-out (`notifyDocument`), and the mapped `recomputeOn`'s forced upstream load stays a follow-up.
Also: N6 as built registers the gcTime default in `hydrateResource` only (the observer path keeps its own
`gcTime`); §1's "an untyped caller missing a required name throws" was not built (the types enforce it).

Implementation review (Opus, adversarial; no blockers):
- S1 `useEditedFiles(convId ?? "")` — fixed (`string | null`).
- S2 half-registration assert on a pushed map throws on deploy skew — fixed (judged against the page's first map).
- S3 `useOptimisticResource` keys not canonical — fixed (+ lint covers it).
- S4 doc stale vs code — this Report.
- S5 test gaps — added the boot hydrate test; `useConfigResult` / `useScopeMembership` / `notifyDocument` / L2 filter
  unit tests NOT added (need a plugin-runtime harness / the DB); covered end to end by the e2e instead.
- N1 pending arm identity + global error — fixed (memoized, error falls back to the global read's).
- N2 every config reader re-renders on each `configScopes` write — accepted (rare writes; reconnects re-render them
  anyway); the reorder comment corrected.
- N3 canonicalization not total — fixed in the runtime once framework changes were approved (see "Framework
  changes"): every entry point, one shared function.
- N4 lint blind spots (nested collection values, spreads, aliased imports) — accepted; domain hooks take `| null`.
- N5 enumerated boot loads have no loader span — accepted (config is in memory); follow-up if a DB-backed one appears.
- N6 per-tuple reports — fixed (one report per key per page load, count + first failure).
- N7 scoped `useConfig` falls back to defaults (not global) while the map is unknown (failed-boot window only) — accepted.
- N8 theme panels torn down under a transient error — fixed (last-known membership).
- N9 docs drift — fixed, framework docs included.
- N10 active-data legacy log stays pending — kept (pre-existing handle semantics; no current consumer).

Framework-increment review (Opus, adversarial, on the runtime canonicalization; no blockers):
- S1 flat forms accepted `optionalParams` with no client counterpart — fixed (tsc rejects it; type test).
- S2 a non-canonical sender would match none of the echoed frames, and the docs said "for any sender" — docs
  corrected (frames echo the canonical tuple); a non-canonical frame is now reported once per key.
- S3 two copies of the rule (client / runtime) could drift — fixed: one leaf, `packages/canonical-params`.
- S4 `loadResourceByKey` / `measureSubscribeCycle` / `triggerResourcePush` / `Resource.load` not canonical — fixed
  (the notify-side call moved into the `scheduleNotify` funnel).
- S5 Report did not describe the increment — this section.
- S6 tests — added: two sockets / two spellings share one span, a `sub-batch` restating in the other spelling keeps
  the held record, `loadResourceByKey`, the flat-form type test.
- N1 malformed frames (`params: null`, non-array `entries`) — guarded. N2 (optional names not tied to `P`), N3 (`null`
  spelling), N4 (`_debug` field), N5 (repeated `?scopeId`) — accepted as nits.

### Deviations from the plan

- B1 / S7 reversed as above (framework scope). The Declare payload carries `preloadTuples` (a loader), not
  `preloadParams`.
- `useScopeMembership` became tri-state (`ResourceResult<boolean>`), touching four theme-engine files.
- Added: `useEditedFiles` / file-peek pane, the secret renderer, and the `secret-meta` loader throw.

### Follow-ups

- **Runtime (framework, not done — outside this task):** (b) a params-only dependsOn edge so a mapped `recomputeOn`
  stops forcing its upstream's loader on every notify (all current mapped users pay it); (d) a watermark-free,
  span-carrying runtime read for enumerated preloads, if one ever becomes DB-backed (today's `resource.load` path has
  no loader span). (a) and (c) are done — see "Framework changes".
- `useConfig`'s scoped read during a failed boot (N7) answers defaults, not the global document.
- The remaining `?? ""` params outside values (`useConversation(id ?? "")`, tree — item 3).
- Resources page: item 9's config deferral is done; the "Value params with no id yet" note under item 7 is done;
  `ResourceDescriptor.initialData` is now seeded only by the tree and tick descriptors.

### For the later tasks

- **Collections (task 3):** `useLive(c, …)` / `useLiveRow(c, null)` skip through `useResource(desc, null)`; a list
  read with nothing to read yet can use the same null (not wired for collection list queries). Domain hooks wrapping a
  read take `string | null`, and `live/no-sentinel-param` guards the call sites.
- **Tree (task 5):** a param'd value may now be preloaded with `preloadParams` (enumerated boot tuples) — a possible
  shape for "the expanded nodes at boot"; L2 will not persist it.
- **In-memory routing (task 9):** a tuple's params are canonical on every path into the runtime (frames, HTTP,
  `scheduleNotify`, cascade, direct loads) — a routing change can key on `paramsKey` without re-canonicalizing.
- **Latency (task 8):** config reads are now boot-snapshot hydrated (no separate config request); every config reader
  observes the shared `config-v2.scopes` value too.
