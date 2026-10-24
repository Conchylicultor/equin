# Live resources: version skew → reload, and failure as its own state

## Context

Commit `f14d715a4` moved `build.history` to `liveCollection`, which requires `params.limit`.
Tabs still running the pre-deploy bundle subscribe with `params={}`. What followed:

- **Server.** The codec throws a plain `Error` (`network/live/core/internal/query-codec.ts:82`).
  `runtime.ts:4176` files it as a `crash` report and sends `sub-error reason:"loader-failed"`.
  The report fired 150 times since 2026-09-26 19:00 and was rate-limited. The sub stays registered,
  so every push reruns the loader and reports again.
- **Client.** It logs the error, refetches over HTTP, gets a 500, retries once, and sets `q.error`.
  `useLive` returns `{pending:true, error}` forever.
- **Builds button.** `build/web/components/build-button.tsx:213` checks only `pending`. It renders
  a wrench that stays disabled forever, and its early return also hides the Reload segment. The
  tab already knew it was stale (`useStaleFrontend` works), but that went unseen.

Three independent defects, fixed in dependency order:

| # | Fix | Why |
|---|-----|-----|
| 3 | Builds button always shows reload advice | Hotfix for the incident; tiny |
| 1 | Server classifies contract mismatch as version skew → app-wide reload | Every future contract change (params, key, schema) repeats this incident |
| 2 | `ResourceResult` gets a distinct error state | ~115 files + ~53 re-shaping hooks can silently render a permanent failure as "loading" |

Research inputs: exploration of runtime.ts / notifications-client / use-resource, and the prior
decision `research/2026-07-09-global-resource-unknown-value-and-error-gate.md` (merged error into
`pending` "so 97 gates become correct for free"; a separate error arm was never evaluated —
this doc supersedes that choice, keeping its I1/I2 invariants for *values*).

---

## Fix 3 — Builds button (one small PR)

`plugins/build/web/components/build-button.tsx` `BuildButton`:
- Pending branch renders the `ButtonGroup` with the disabled wrench **plus `<ReloadSegment advice={advice}/>`**
  (it already returns `null` for `none`). Reload advice is independent of the history read.
- When `historyResult.error` is set, render the wrench with an error tooltip; clicking calls
  `historyResult.refetch()`. It is no longer disabled. After fix 2, this becomes the `status:"error"` arm with
  `<ResourceErrorInline variant="icon">`.
- Test: `plugins/build/web/__tests__/build-button.test.tsx` — pending + stale advice shows Reload;
  error shows the error affordance, not a forever-disabled button.

---

## Fix 1 — Contract mismatch is version skew, not a crash

### 1a. Shared protocol leaf
New `plugins/packages/plugins/resource-protocol/core` (a leaf: the resource-runtime barrel pulls `node:crypto`,
so web can't import it, and runtime must not import live-state). Exports:
- `SubErrorReason = "unknown-key" | "unauthorized" | "loader-failed" | "contract-mismatch"`
- `ContractVerdict = "skew" | "same-build" | "unknown"`
- `SubErrorFrame`, `ResourceHttpErrorBody { reason; verdict?; detail? }`, `BUILD_GRAPH_HEADER`
- `class ResourceContractError extends Error { key; detail }`

`sendJson` (runtime.ts:2446) is typed against a `ServerFrame` union. The client `ServerMsg.reason`
(notifications-client.ts:279) becomes `SubErrorReason`.

### 1b. Throw typed, validate at the gate
- `query-codec.ts`: decode paths (`decode`, `decodeGroups`, `parseJson`, `decodeWhere`) throw
  `ResourceContractError`. Declaration-time failures (`:88`, encode) stay plain `Error`, so they still crash loudly.
  Same for `window-descriptor.ts:79-86` and `live-state/core/window.ts:88` (point decode).
- Runtime `ResourceContract` (runtime.ts:506) gets a **required** `validateParams(params)` (tsc forces
  every factory to decide):
  - `liveCollection` window/`:rows`/`:groups` → its decoders.
  - `liveValue` (`network/live/core/internal/live-value.ts`) → an exact key-set check against `spec.params`,
    string values. Today nothing validates, and loaders see `undefined`.
  - Legacy tree/revision-tick/config descriptors → an explicit named `acceptAnyParams`.

### 1c. Runtime (`framework/plugins/resource-runtime/core/runtime.ts`)
- `handleSub` (:3988) / `handleSubBatch` (:4279): `validateParams` runs **before** `authorize` and
  `registerSubOnSocket`. On failure, send `sub-error reason:"contract-mismatch" verdict` and never register,
  so push, revalidate and scoped paths never rerun it. Batch: rejected entries are left out of `retained`.
- Unknown key: keep `unknown-key`, add a verdict.
- Loader-catch backstop (:4176) and push paths: a `ResourceContractError` from a registered tuple is a gate
  gap. It unregisters the tuple (extract `unregisterSubOnSocket` from the unsub path ~:4488, then
  `unregisterTupleEverywhere`), sends `contract-mismatch`, and **always reports**.
- HTTP (:4515+): unknown key → 404 JSON body; contract failure → **409** JSON body (`no-store`);
  other loader throw → 500 JSON `{reason:"loader-failed"}`.
- One helper, `rejectContract(...)`, computes the verdict and applies the reporting policy:
  - `skew` → no report, `console.warn`.
  - `same-build` / `unknown` → `reportLoaderError`, with errorType `ResourceContractError`. It stays loud: a
    current-build client failing decode is a real bug.

### 1d. Build identity in the verdict
- The client sends `build: VITE_BUILD_GRAPH ?? "dev"` **per frame** on `sub`/`sub-batch` (a shared-socket leader
  relays follower tabs that may run different bundles), and `BUILD_GRAPH_HEADER` on HTTP.
- Server: `server-core/core/resources.ts` gets a `setClientBuildIdentity(fn)` setter (the
  `setLiveStateSnapshotHooks` pattern, since framework can't import build). `build/plugins/server-build-id/server`
  registers the **boot-memoized** graph (not the fresh read, which lies during the dist-swap window).
- Verdict:

  | Client build | Verdict |
  |---|---|
  | absent (pre-feature bundles, i.e. this incident) | `skew` |
  | `"dev"`, or server graph unknown | `unknown` |
  | differs from server graph | `skew` |
  | equal | `same-build` |

- Central runtime passes no hook, so its verdict is `unknown`.

### 1e. Client
- New module store `live-state/web/resource-contract-store.ts` (exported from the barrel):
  `markResourceContractMismatch({key, reason, verdict})`, `useResourceContractMismatches()`. It lives in
  live-state because the transport owns it; build/web already imports live-state.
- The `sub-error` handler (notifications-client.ts:1469) marks the store for `contract-mismatch`/`unknown-key`,
  then keeps the existing `applyInvalidate`. The HTTP refetch now gets a 409/404 JSON body, so the error lands in
  the one existing RQ error channel with a typed reason. **No RQ internals touched** (one extra request, accepted).
- `ResourceHttpError` (:141) gains `reason?`/`verdict?`. `fetchOverHttp` (:1024) parses the JSON body on `!ok`
  and marks the store.
- `use-resource.ts:41` retry: don't retry `contract-mismatch`/`unknown-key`.

### 1f. Reload advice
- `build/web/hooks/use-reload-advice.ts`: new arm `{ kind:"outdated"; stale; count }` from
  `useResourceContractMismatches()` (skew entries). Precedence: broken > outdated > stale.
- `reload-segment.tsx`: copy "This tab is out of date and can't load some data — reload to fix", with a destructive
  tint.

---

## Fix 2 — Failure is a distinct, un-ignorable state

### Type
`live-state/web/use-resource.ts`:
```ts
type ResourceResult<T> =
  | { status: "loading"; refetch }                                  // never had a value, no error
  | { status: "error"; error: ResourceError; stale?: T; refetch }   // error is never null
  | { status: "ready"; data: T; refetch };
type ResourceError = { kind: "loader-failed" | "not-found" | "client-outdated" | "transport"; message; cause };
```
- `ResourceError` is built in `fetchOverHttp` from fix 1's typed body (`contract-mismatch` →
  `client-outdated`); a client-side zod parse failure also → `client-outdated`.
- Same move for `LiveListResult` (paging on `ready`; a failed grow → `error` with `stale` = previous window),
  `LiveRowResult` (`ready` + `found:true|false`, gains `refetch`), `useConfigResult`, `CombinedResources`
  (precedence error > loading > ready), and `GateInput = { status }`.
- `useOptimisticResource` stays the single named exemption (ready, plus a sync error via sync-status).
  `useConfig`'s `stale ?? defaults` stays sanctioned for cosmetic reads.

### Enforcement
- **tsc:** once `pending` is removed, every site must name a status.
- **Lint `live-state/no-ready-negation`** (syntactic): on a resource-result binding, `.status` may only be compared
  to `"loading"`/`"error"`, so `!== "ready"` is banned. An explicit `switch` fall-through is allowed. This
  closes the one-line re-collapse tsc can't see.
- **Lint `live-state/no-handrolled-result`:** no `status:"loading"|"error"` result literal/type outside
  live-state + live. Domain hooks must return `ResourceResult<U>` via `mapResource`/`combineResources`, which ends
  the ~53 error-erasing re-shapes (`conversations/web/use-conversations.ts:31`, `tasks/web/client.ts:53`,
  `ui/theme-engine/web/use-resolved-theme.ts:14`, `page/editor/web/block-store.ts:42`, …).
- `no-pending-data-collapse` extended to match `status` tests.

### New primitives (live-state/web)
- `foldResource(r, { loading, error, ready })`, all handlers required, for `.ts` derivations
  (e.g. `use-stale-frontend.ts:25` writes `error: () => ({stale:false…})` explicitly).
- `<ResourceErrorInline error refetch variant="block"|"inline"|"icon"/>` with retry; `client-outdated` renders
  "App updated — reload".
- `matchResource`/`ResourceView` move to `status`; their 51 files are unchanged.
- DataView (`data-view/core/internal/types.ts:1091`): `loading?: boolean` → `readiness?: ResourceResult-shaped`,
  plus an `errorState` override (callers pass `readiness={rows}`).

### Plumbing
- **Sticky error:** the `up-to-date` reply on reconnect (notifications-client.ts:1623) must clear `q.error` for
  that exact sub (currently it leaves the resource errored until the next push).
- **Event-driven retry** (no timers): reconnect resubscribe (already), `online` and `visibilitychange→visible`
  refetch only errored queries, and the error UI's retry button.
- **Report sink** `resourceErrorReportSink` (`defineReportSink`, like `slow-resource-reporter.ts`): emitted once
  per (key, params) on error null→set from `NotificationsClient`, not per hook. A reports sub-plugin collects it,
  and a health row shows "N resources failing". So even an ignoring caller produces a loud signal.

### Phased migration
- **P1 — foundation (one PR, additive):** add `status` to all arms and keep `pending` as `@deprecated` computed;
  add `ResourceError`, `foldResource`, `ResourceErrorInline`, DataView `readiness`, the sink, retries, the
  sticky-error fix and the two lint rules. Update `live-state/CLAUDE.md` (the `pending` section) and
  `network/live/CLAUDE.md`.
- **P2 — burn-down (parallel agent PRs, one per plugin tree):** a temporary `live-state/no-deprecated-pending`
  rule with a shrink-only generated baseline. Recipes by bucket:

  | Bucket | Count | Recipe |
  |---|---|---|
  | matchResource/ResourceView | 51 files | none |
  | reads `.error` | 19 | rename |
  | `if (x.pending) return <JSX>` | 74 | loading → same JSX; error → `ResourceErrorInline` (variant chosen per slot) |
  | ternaries | 47 | `matchResource` |
  | `.ts` derivations | 53 | `mapResource`, else `foldResource` with an explicit error value |
  | re-shaping hooks | ~53 | `mapResource`; fix consumers tsc then flags |
  | `stale` readers | 8 | read `stale` from the error arm |

- **P3:** delete `pending`, DataView `loading`, and the migration rule.

---

## Critical files
- `plugins/framework/plugins/resource-runtime/core/runtime.ts`
- `plugins/network/plugins/live/core/internal/{query-codec,window-descriptor,live-value}.ts`
- `plugins/primitives/plugins/live-state/web/{notifications-client,use-resource,resource-utils}.ts`, `web/components/resource-view.tsx`
- `plugins/network/plugins/live/web/internal/use-live.ts`
- `plugins/framework/plugins/server-core/core/resources.ts`, `plugins/build/plugins/server-build-id/server`
- `plugins/build/web/{hooks/use-reload-advice.ts,components/reload-segment.tsx,components/build-button.tsx}`
- `plugins/primitives/plugins/data-view/core/internal/types.ts`, `plugins/primitives/plugins/live-state/lint/`
- New: `plugins/packages/plugins/resource-protocol/core`

## Verification
- **Unit and jsdom suites** (`./equin test <plugin>`):
  - `query-codec` / `window-descriptor`: typed throw vs. declaration throw.
  - `live-value`: `validateParams`.
  - New `runtime-contract-mismatch.test.ts`: a bad sub is not registered, a later notify runs no loader and files no
    report, skew is unreported while same-build/unknown is reported, and HTTP returns 409/404 JSON.
  - `runtime-sub-batch`.
  - `notifications-subs` / `notifications-http-fetch`: the store is marked, the reason is typed, the build header is
    sent, and there is no retry.
  - `use-resource-error-gate` on `status`, including the sticky-error clear.
  - `resource-utils` (combine precedence, fold).
  - Lint rule tests.
  - `reload-advice`: outdated arm and precedence.
  - `build-button`.
- **End to end, reproducing the incident:** `./equin build`, open the worktree app, then change
  `build.history`'s codec (e.g. add a required param) and rebuild without reloading the tab. Expected:
  - the Builds pill shows the red "out of date" Reload;
  - the history read shows an error, not a spinner;
  - the `reports` table (`query_db`) has no new `crash` row.
  Then flip the check so a current-build client fails decode, and confirm a `ResourceContractError` report is filed.
- Repeat with `screenshot.ts --click "Builds"` for visual confirmation.
