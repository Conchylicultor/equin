# Resources track — re-check of the open items, and item [10]: latency in slow-ops

Track: Network Layer › Resources (page `block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`). Task `task-1791902228-6w9h61`.

## Part 1 — Re-check of the unverified items (HEAD `19d887ceb0`)

| Item | Verdict | What the code says |
|---|---|---|
| [4] Live plugins under `network/live` | not started (umbrella only holds `filter`) | 11 candidates: resource-runtime, live-state, query-resource, live-state-snapshot, boot-snapshot, optimistic-mutation, resource-protocol, canonical-params, resource-vocabulary (+ change-feed arguable). `plugin move` dry-runs all plan cleanly, no cycles. The live-state move rewrites ~493 files, so it is a merge-churn hazard: do it when no live-stack branch is in flight. `keyed-resource-scope` check is now vacuous → delete, don't move. |
| [8] In-memory routing per subscription | **cheaper equivalent shipped**; the literal `routeTuples` where-test is not built | The router gates per tuple on changed columns, static key match and `moves` columns, drops non-held rows that cannot move, and point sets only see their own ids. The change feed carries no row values, so a where cannot be tested in memory. Main never shows more than 2 tuples on a window, so the gain today is close to zero. This is the deferral trigger the 2026-09-25 design doc already set. |
| [9a] `scopedMembership` | **not legacy any more** | P8 v3 made it the compiled form of every `all` collection (22 collections; only built in `query-resource/.../compile-alias.ts:554`). The remaining work is to fold it into `membership` as a named unbounded arm: one optional cleanup session with no behaviour change. The persisted snapshot (L2) was rebuilt on purpose for `all`, so it is not a legacy path either. Config boot hydration is gone, and `live/no-legacy-resource-spelling` has 0 debt. |
| [9b] Endpoint reads | open: **60 debt files in 37 plugins** (+3 sanctioned) | 56 web hook calls (46 `useEndpoint`, 3 `useEndpointResource`, 6 direct TanStack, 1 legit `useQueryResource`). B1–B3 of `research/2026-10-11-global-endpoint-reads-onto-live.md` have landed; B4–B10 remain, about 6–8 sessions. 19 of the files are DB-backed. `task-1790861959037-0kqpcq` (direct `useQuery`) is fully contained in `woqgfi`. |
| Exit criterion "every DB read routed" | collections done (0 legacy collections); **29 `source:"db"` values legacy-full**, + 6 externals with a DB read-set | Values are typed `reach?: never`, so none can be routed today. The 2-3 session fix is a declared-reach spelling for DB values (`reads: [{table, match}]` → ReachPlan, with the A8 drift guard). The criterion should be restated so that whole-table bounded values with a declared reason are acceptable. Deleting `applyLegacyFullChange` waits on this. |
| [10] Latency in slow-ops | **half done** | Server: a `route` span with `sinceChangeMs`, a `deliver:<key>` span (enqueue→send, no change time). The browser computes change→applied per frame but feeds only the latency-ledger histogram, without the key. Write→confirm is not measured at all. |

**Chosen next item: [10].** It closes a whole exit criterion in about one session, only adds signals, and conflicts with nothing in flight. It also gives the later declared-reach work per-key timings to show its effect.

**Order after it:**
1. Declared reach for DB values: restate the criterion, design, migrate the 29, then delete the read-set router.
2. Endpoint reads, DB-backed batch first.
3. `scopedMembership` fold (optional).
4. [4] moves, last.

## Part 2 — Plan for [10]


Paths are relative to `/Users/epot/__A__/dev/singularity/.claude/worktrees/att-1791905185-cbk4nv/`. I spot-checked the main claims against the code. Each one below is confirmed, with the line where it lives:

- **The update sample has one consumer, and that consumer replaces any other.** `register` in `plugins/primitives/plugins/report-sink/core/internal/define-report-sink.ts:48-54` replaces the single handler, and it swallows any error the handler throws (`:40-45`). Only latency-ledger registers for `updateDelayReportSink`, and only live-state files reference it.
- **Some deltas are recorded as applied when they were not.** `notifications-client.ts:2207` reports a delta unconditionally. But `applyDelta` returns early when it has to force a full resubscribe: when there is no base (`:2324-2332`) or when the base has drifted (`:2368-2376`). Today's ledger `update-e2e` metric counts those frames too.
- **The standalone ack edge never reports.** The `txAcks.subscribe` → `ackPass` handler at `use-optimistic-resource.ts:542-555` never calls `reportOutcomes`. `reportOutcomes` itself (`:449-455`) only reports `dropped` and `stalled`.
- **Confirmed ops leave no record.** `reconcile` drops `confirmed` and `denied-silent` ops together and records neither (`overlay.ts:413-416`). `ReconcileResult` (`:147-151`) only has `pending`, `dropped` and `stalled`. `PendingOp` (`:95-131`) carries no timestamps.
- **The server delivery hook has no change time.**
  - `onDelivered(key, latencyMs, subscribers, frameChars)` is declared at `runtime.ts:1350` and called at `:4633`, `:4984` and `:5407`.
  - server-core records only `{subscribers, frameChars}` (`server-core/core/resources.ts:317-324`).
  - `sinceChangeMs` is already a declared span measure (`runtime-profiler/core/recorder.ts:119-124`).
- **Only the update and delta frames carry `changedAt`** (`frames.ts:257-281`). On the client, only `notifications-client.ts` reads it.
- **The slow-ops client item has no `waits` or `detail` field** (`slow-ops/shared/endpoints.ts:11-33`). `operationKind` is a plain `z.string()`.
- **`perfFloorMs` lists the server thresholds by name** (`resolve-threshold.ts:121-129`). A new client threshold left out of it cannot lower the profiler floor.
- **`perfs/plugins/` already exists**, with `boot-trace` and `scheduler`.

## Context

Slow-ops shows client signals today (`page-load`, `element`) but nothing about live-push staleness or about how long an optimistic write takes to be confirmed.

- The live-state change→applied sample exists, but it feeds only the latency-ledger histogram and drops the resource key.
- Optimistic writes are not timed at all.
- On the server, `deliver:<key>` measures first-notify→send. It cannot see a stalled serving thread, and it does not record a change time.

## Design

I recommend **Plan B, the structural one**, with Plan A's scope discipline grafted on. It fits in about one session.

**D1. A multi-subscriber sink primitive: `defineObservationSink<T>()`, in report-sink core.**
- It exposes `subscribe(fn) → unsubscribe`, `emit(body)` and `hasSubscribers()`.
- It does not hold or replay anything.
- If a subscriber throws, the error is rethrown with `queueMicrotask`. That keeps the failure loud without breaking the frame-apply path.
- `defineReportSink` stays exactly as it is. It is an error-path primitive with one handler that holds reports, used by about 25 sinks, and changing its contract would be churn.

**D2. A closed signal vocabulary: new leaf plugin `plugins/primitives/plugins/perfs/plugins/latency-signal/`, `core/` only.**
- `CLIENT_LATENCY_SIGNALS` maps each signal to its tuple of phase names, typed `as const`. It is closed plain data in `core/`, as the repo rule asks.
- `ClientLatencySample` is a union discriminated on `signal`, with `phases: Record<PhaseOf<S>, number>`. tsc then rejects a missing or misspelled phase.
- `clientLatencySink` is an observation sink.
- `splitPhases` is a pure helper that clamps every phase to ≥ 0.
- live-state and optimistic-mutation produce samples; slow-ops and latency-ledger consume them.

**D3. Co-produced frame timing: protocol bump.**
- `update` and `delta` frames replace `changedAt?` with `timing?: { changedAt, sentAt, deliverMs }`.
- A frame cannot carry a change time without a send time.
- The frame vocabulary hash (`PROTOCOL`) changes as a result. A tab on an old bundle gets its own socket, which is safe.
- This is what makes the four-way split of `update` possible.

**D4. Server half of (a) in `get_runtime_profile`.**
- `onDelivered` takes an info object: `{latencyMs, subscribers, frameChars, changedAt?}`.
- `deliver:<key>` gains the measure `sinceChangeMs`.
- Client samples are **not** pushed into the in-memory span recorder: `SPAN_KINDS` is closed and the threshold switch is exhaustive over it.

**D5. A generic consumer in slow-ops.**
- The collector never names `update` or `confirm`.
- It looks up the threshold through `CLIENT_SIGNAL_THRESHOLD: Record<ClientLatencySignal, keyof SlowOpThresholds>`, so tsc forces a new signal to come with a threshold.
- The sample's phases become the slow-op `waits`, and its params (or its confirm mode and edge) become `detail.variant`.
- `operation` is the resource key only, so the number of rows stays bounded.

**D6. Timestamps on `PendingOp`, plus a `confirmed` list in `ReconcileResult`, tagged with the confirmation mode** (exact-ack, watermark, content or tokenless) and the edge.
- Tokenless confirmations are not causal, so the tag keeps those numbers from being read as proof.

**D7. Hidden-tab exclusion rule.**
- A sample is `hidden` if the tab is hidden now, or if it was hidden at any point since the start stamp (`changedAt` for an update, dispatch for a confirm).
- live-state keeps one page-global `lastHiddenAt`.

## Changes by file

### report-sink
- New `core/internal/define-observation-sink.ts`, exported from `core/index.ts`.

### perfs/latency-signal (new)
- `core/index.ts` is the barrel. It holds the `default … satisfies PluginDefinition` and re-exports from `core/internal/signals.ts`, which holds the signal table, the types, `clientLatencySink` and `splitPhases`.

| Signal | Phases |
|---|---|
| `update` | `server-notice`, `server-deliver`, `transport`, `client-apply` |
| `confirm` | `send-lane`, `retry`, `server-ack`, `confirm-frame` |

- Add a `CLAUDE.md`.

### resource-protocol
- `core/internal/frames.ts:265` and `:280`: `changedAt` becomes `timing: w.optional(w.object({changedAt, sentAt, deliverMs}))`.
- Update the doc comment at `:183`.

### resource-runtime (`core/runtime.ts`)
- Build `timing` only when `pendingEntry.changedAt` is set.
  - `sentAt = Date.now()`
  - `deliverMs = performance.now() - enqueuedAt`, the same quantity `onDelivered` measures today.
- Send sites: `sendUpdate` (`:2725-2754`), the keyed first send and FULL delta (`:4593-4626`), the membership delta (`:4966-4982`) and the non-keyed update (`:5389-5399`).
- `onDelivered` (`:1345-1355`) takes the info object. Its call sites are `:4633`, `:4984` and `:5407`, and they pass `changedAt`.
- Update `core/testing/routed-fixture.ts` if its frame assertions use `changedAt`.

### server-core (`core/resources.ts:262-324`)
- `ResourceDeliveryObserver` takes the info object.
- `onDelivered` records `measures: {subscribers, frameChars, sinceChangeMs?: Date.now() - changedAt}`.
- Update its only external observer: latency-ledger `server/internal/recorder.ts:172-173`.

### live-state (`web/notifications-client.ts`)
- In `onmessage` (`:1730-1739`), take `receivedAt = Date.now()` before `JSON.parse` and thread it into `handleServerMessage`. It is an optional argument defaulting to `Date.now()`, so test harnesses keep working.
- `applyUpdate` and `applyDelta` return `"applied" | "resubscribed"`. The early returns at `:2324-2332` and `:2368-2376` return `"resubscribed"`. A sample is emitted only on `"applied"`, which fixes the false-sample bug.
- `reportUpdateDelay` (`:2214-2225`) becomes `reportUpdateLatency(key, params, timing, receivedAt)`.
  - It returns immediately when `timing` is absent or when `!clientLatencySink.hasSubscribers()`.
  - The four phases are computed as in this table:

| Phase | Computed as |
|---|---|
| `server-notice` | `sentAt − deliverMs − changedAt` |
| `server-deliver` | `deliverMs` |
| `transport` | `receivedAt − sentAt` (the only phase that crosses clocks) |
| `client-apply` | `appliedAt − receivedAt` |

  - `totalMs = appliedAt − changedAt`.
  - "Applied" means the cache has been written, not that React has painted. This matches today's `update-e2e`.
- Add a `visibilitychange` listener that maintains `lastHiddenAt`.
- Delete `web/update-delay-reporter.ts` and remove its export from `web/index.ts`.

### optimistic-mutation
- **`web/internal/overlay.ts`**
  - Add `dispatchedAt`, `firstSentAt?`, `lastSentAt?`, `attempts` and `ackedAt?` to `PendingOp`. All are `performance.now()`, the client's own monotonic clock, so these phases have no skew.
  - Add a pure `markSent(pending, opId, at)` next to `markFailed` (`:671-677`).
  - `markResolved` (`:649-663`) takes `ackedAt`.
  - Add `confirmed: ReadonlyArray<{op, mode}>` to `ReconcileResult`. In `reconcile`, split the `"confirmed"` case out of `"denied-silent"` (`:413-416`).
  - The mode is decided in:
    - `confirmPass` (`:472-528`)
    - `resolvePass` (`:572-614`): exact ack at `:594-595`, content at `:596-600`, coarse at `:602-606`, tokenless at `:608`
    - `ackPass` (`:631-642`)
  - Every identity result returns `confirmed: []`.
- **`web/internal/use-optimistic-resource.ts`**
  - Stamp `dispatchedAt` in the dispatch literal (`:684-691`).
  - Call `markSent` at the top of `runMutate` (`:576-578`). That is the point after the send lane, so it marks real wire departure, and retries re-enter there.
  - Pass `ackedAt` into `resolvePass` (`:594`).
  - `reportOutcomes(next, edge)` emits `signal: "confirm"` for each confirmed op, with `variant: \`${mode}/${edge}\``.
  - Phases:

| Phase | Span |
|---|---|
| `send-lane` | firstSent − dispatched |
| `retry` | lastSent − firstSent |
| `server-ack` | acked − lastSent |
| `confirm-frame` | max(0, confirmed − acked) |

  - `totalMs = confirmed − dispatched`.
  - Assert that `ackedAt` and `firstSentAt` are present: a confirmed op is always resolved, so a missing stamp should fail loudly.
  - The edges are `push` (`:511-518`), `resolve` (`:594-607`) and `ack`. Add a `reportOutcomes(next, "ack")` call at `:547-553`.

### latency-ledger
- `web/components/latency-collector.tsx:13-18`: subscribe to `clientLatencySink` and record `update-e2e` = `totalMs`, with `excluded: hidden`.
- `server/internal/recorder.ts`: switch to the info-object observer.

### slow-ops
- **`core/config.ts`**
  - Add `updateMs` and `confirmMs` as `intField`s.
  - Add `CLIENT_SIGNAL_THRESHOLD`.
  - Add a comment saying these must stay out of `perfFloorMs`.
- **`shared/endpoints.ts`**
  - Add `waits: z.record(z.string(), z.number()).optional()` and `detail: z.object({variant: z.string().optional()}).optional()`.
  - `element`'s `transportWaitMs` becomes `waits["notifications-transport"]`. `transportColdStart` stays, because it drives the report title.
- **`server/internal/handle-client-slow-op.ts`**
  - Extract a pure `toRecordInput(item, traceId)` that passes `waits` and `detail` through.
  - Capture **one trace per (batch, operationKind)**, shared by every item of that kind. This keeps a storm from consuming the global budget of 30 traces per minute.
- **`web/components/slow-op-collector.tsx`**
  - Add one generic effect that subscribes to `clientLatencySink`, skips hidden samples, compares against the threshold, and calls `enqueueSlowOp({operationKind: s.signal, operation: s.key, caller: route, detail: {variant: s.variant ?? canonicalJson(s.params)}, waits: s.phases, durationMs, thresholdMs})`.
  - Move element's existing enqueue onto `waits`.
- **`server/internal/slow-op-kind.ts` `renderDescription` (`:44-87`)**
  - Add generic "largest wait layer and its share" text, with hints from a small `WAIT_LAYER_HINTS` table. No branches per kind.
- **Comment and description fixes** where the code lists `"page-load" | "element"`:
  - `shared/endpoints.ts:6-7`
  - `handle-client-slow-op.ts:17-19` and `:51-52`
  - `slow-op-collector.tsx:11-14`
  - `web/index.ts:12`
  - `slow-op-queue.ts:8`
- **`get_runtime_profile` tool description** (`profiling/plugins/runtime/server/internal/mcp-tools.ts:20`, `:66`): mention `sinceChangeMs` on `deliver:<key>`, and point to Debug → Slow Events and `get_timeline` for client kinds.

### trace pane
- Add tints for `update` and `confirm` in `trace/plugins/pane/web/internal/trigger-meta.ts:6-19`.

### Unchanged
- The `slow_ops` table and its migration (the waits field is an open record)
- The Aggregates and Cluster tabs (their Kind options come from the data)
- The Timeline source
- The queue
- The reports engine

## Thresholds and config

| Knob | Default | Rationale |
|---|---|---|
| `updateMs` | 1000 | The ledger's calm p95 exit bar (`latency-ledger/core/internal/metrics.ts:102-117`). |
| `confirmMs` | 2000 | Matches `pageLoadMs`, `loaderMs` and `httpMs`; covers the HTTP round trip plus the push. |

- The origin jsonc is regenerated by `./singularity build`.
- Neither knob goes into `perfFloorMs`.

## Edge cases

- **Frames with no timing produce no sample.** That covers the boot snapshot, sub-ack, up-to-date, HTTP fallback, catch-up replay, synthetic pushes, standalone ack, invalidate and forced-resub deltas. The protocol type guarantees it, so no runtime check is needed.
- **Reconnects create no samples.** Replay answers with timing-less frames.
- **A real stall shows up as a burst of samples, which is the signal.** The burst is bounded by:
  - the queue cap of 1000 items, with the dropped count reported;
  - one trace per kind per batch;
  - the report fan-out ceiling of 20 fingerprints per minute, which then folds into a `report-storm` rollup.
- **Multiple tabs.** Each visible tab reports its own sample, so the row's count includes them all. The route caller shows which surface each came from. This is documented, not deduplicated.
- **Clock skew.**
  - Only the `update` signal's `transport` phase crosses clocks, so skew stays in that one named layer.
  - The server phases use the server clock; `client-apply` and every confirm phase use the client clock.
  - Same-machine is the documented assumption (`runtime.ts:934-940`).
- **Confirmed before the HTTP response** (resolve edge). `confirm-frame` is 0 and the variant says `/resolve`; the total is still correct.
- **Ops that never confirm emit nothing.** That covers denied, permanently rejected, stalled and unmounted-while-pending ops. Rejected and stalled ops are already reported on their own sinks.
- **Write paths not covered** (to be stated in the docs):
  - detached `enqueueResourceWrite`
  - `useEndpointMutation` invalidates
  - config_v2 writes
  - Yjs collab text
  - `editable-field`

## Tests

Run all of them with:

```
./singularity test plugins/primitives/plugins/report-sink plugins/primitives/plugins/perfs/plugins/latency-signal plugins/primitives/plugins/live-state plugins/primitives/plugins/networking plugins/primitives/plugins/optimistic-mutation plugins/framework/plugins/resource-runtime plugins/debug/plugins/slow-ops plugins/debug/plugins/latency-ledger
```

- **report-sink**, `define-observation-sink.test.ts`:
  - fans out to every subscriber, and unsubscribe works;
  - an emit with no subscriber is not held;
  - a throwing subscriber does not stop the others, and its error is rethrown asynchronously.
- **latency-signal**, `splitPhases`: negative phases clamp to 0, and the phases sum to the total.
- **live-state**, jsdom tests on the transport-hub fakes:
  - an update or delta with `timing` emits one sample with four phases;
  - sub-ack and timing-less frames emit nothing;
  - a no-base or drifted delta emits nothing (regression test for the bug);
  - the `lastHiddenAt` rule;
  - no work when nobody subscribes.
  - Also run the existing `notifications-subs`, reconnect and cross-tab hazard suites.
- **resource-runtime**:
  - a frame carries `timing` exactly when `changedAt` is known;
  - `onDelivered` receives the earliest merged `changedAt`;
  - catch-up frames carry no timing.
- **optimistic-mutation**:
  - `overlay.test.ts`:
    - `confirmed` and its mode are populated for confirmed ops only, never for denied or denied-silent ones;
    - `markSent` and `attempts`.
  - `use-optimistic-resource.test.tsx`: one sample per edge. Assert the structure (edge, mode, attempts, stamp order), not absolute times.

| Case | Expected edge | Reuses |
|---|---|---|
| Push arrives after the response | `push` | |
| Push arrives before the response | `resolve` | the `:337-385` and `:1010-1024` scenarios |
| Standalone ack frame | `ack` | the `:690-725` scenario |
| Retry through `drainFailed` | `attempts: 2` and a `retry` phase | |
| Queued second op | its `firstSentAt` is later than the first op's resolve | |
| Rejected or superseded op | nothing emitted | |

- **slow-ops**:
  - `toRecordInput` maps fields correctly, and only one trace is captured per kind per batch;
  - collector: the threshold is read per signal, hidden samples are skipped, and the item has the right shape;
  - the description names the dominant layer.
- **latency-ledger**: the collector still records `update-e2e`.

## Docs

- `report-sink/CLAUDE.md`: when to use a report sink (one handler, held reports) and when to use an observation sink (many subscribers, nothing held).
- `latency-signal/CLAUDE.md`: the signal table, what each phase means, which phase crosses clocks, and how to add a signal in three steps (table entry, threshold, emit).
- `live-state/CLAUDE.md`: the update latency sample, the receipt stamp, which frames carry timing, the hidden rule, and the resubscribe rule.
- `resource-runtime/CLAUDE.md`: the `timing` frame field.
- `optimistic-mutation/CLAUDE.md`: the confirm signal, its edges and modes, and what is out of scope.
- `slow-ops/CLAUDE.md`:
  - fix the opening at `:3-4`;
  - add a "Client latency kinds" section after `:54-80` covering the thresholds and why they stay out of `perfFloorMs`, hidden exclusion, the per-batch trace rule, the phases, and one sample per tab.
- Plugin docs are regenerated by the build (`plugins-doc-in-sync`).

## Verification (e2e)

1. Run `./singularity build` in the background, then `./singularity await`.
2. Add a script at `plugins/debug/plugins/slow-ops/e2e/client-latency.ts`, built on the e2e-harness helpers (`withBrowser`, `report`). It:
   - sets `updateMs` and `confirmMs` to 0, and restores them in a `finally`;
   - types into a page block, which goes through the optimistic, exactly confirmed path (`page/plugins/editor/web/block-store.ts`);
   - waits about 1 s for the beacon;
   - opens Debug → Slow Events → Aggregates and asserts that `update` and `confirm` rows exist with ⏳ phase lines.

   Run it with `./singularity run plugins/debug/plugins/slow-ops/e2e/client-latency.ts`.
3. Cross-check with MCP:
   - `query_db`:
     ```sql
     select operation_kind, operation, count, waits, variants
     from slow_ops
     where operation_kind in ('update','confirm')
     order by last_seen_at desc;
     ```
     Expect the four update layers, and the `send-lane`, `server-ack` and `confirm-frame` layers on confirm rows.
   - `get_runtime_profile`, kind `push`: `deliver:<key>` shows `measuresMax.sinceChangeMs`.
   - `get_timeline` over the last 5 minutes: shows `update <key>` and `confirm <key>` events, and their trace.
4. Manual attribution check: hold a transaction open on a table the page reads. `server-notice` should dominate the new `update` row, and the report should name it.

## Decisions taken (defaults; flag in review)

1. **Reports.** These kinds share the `slow-op` report kind and its fan-out budget of 20 fingerprints per minute. A storm folds into `report-storm`, which is the existing designed behaviour. The fold is not special-cased.
2. **Thresholds.** `updateMs` 1000 is the ledger's calm p95 bar. `confirmMs` 2000 matches the other client and http knobs. Both can be tuned in Settings → Config.
3. **`get_runtime_profile`.** Only the tool description changes: it points to Debug → Slow Events and `get_timeline` for the client kinds. It reads `sinceChangeMs` on `deliver:<key>` itself.
4. **Ledger.** No `confirm-e2e` metric yet. It is filed as a sidequest.
5. **Sidequests to file after landing:**
   - Move server-core's observer Sets onto `defineObservationSink`.
   - Fold same-key items in the slow-op queue.
   - Add a clock-offset estimate for cross-device browsers.
   - Add a `confirm-e2e` ledger metric.
   - Cover the write paths that are not covered yet (detached `enqueueResourceWrite`, config_v2, collab text).

## As landed (2026-10-14, worktree `att-1791905185-cbk4nv`)

Built and deployed. type-check, boundary checks and 1,145 tests across 13 plugins pass. The e2e `plugins/debug/plugins/slow-ops/e2e/client-latency.ts` passed 3/3 consecutive runs, each confirming the typed text was saved. The one earlier failure was lost keystrokes, not a missing sample, and the script now checks for that first.

**Deviations from the plan:**
- **`latency-signal` barrel.** It has no default export, matching the other core-only plugins.
- **Return values.** `applyUpdate` stays `void` because it has no resubscribe path. `applyDelta` returns `"applied" | "resubscribed"`.
- **Hidden-tab stamps.** `lastHiddenAt` is a field on the `NotificationsClient` singleton. optimistic-mutation has its own `tab-hidden.ts` on the `performance.now()` clock, so the two signals never mix clocks.
- **Overlay types.** `Verdict` and `Evaluation` in `overlay.ts` became objects, so the confirm mode travels with the verdict. `resolvePass` and `markResolved` take `ackedAt` as a required argument.
- **Report waits.** The slow-op report payload gained `waits`. `describeWaits` names the dominant layer for every kind that has waits, server spans included.
- **Traces.** One trace per (batch, kind), taken from the slowest item. This now also applies to `page-load` and `element`, which used to get one trace per item.

**First numbers (worktree, e2e with thresholds at 0):**
- `confirm page-blocks` is always `exact-ack/resolve`. The server ack takes about 1.0–1.1 s per write. The confirm frame takes about 1 ms, because the push lands before the HTTP response.
- `update` rows cover every live resource on screen. One unexpected finding: on `queue-health.pulse` and `pages.tree`, the `transport` phase (server send → browser `onmessage`) averages 0.2–0.4 s. That is too long for localhost. `onmessage` only runs once the browser main thread is free, so main-thread busy time is likely counted as transport. This needs its own investigation.
- `deliver:<key>` in `get_runtime_profile` carries `measuresMax.sinceChangeMs`, for example `page-blocks` at 756 ms and `icons.saved-sprites` at 3.6 s.
