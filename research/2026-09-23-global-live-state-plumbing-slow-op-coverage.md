# Live-state plumbing in unified slow-op profiling

## Context

The live-state audit page (§10.4, block `block-fbee0e5f-…`) found that Debug → Slow Ops
records the compute path well: the loader run, the flush cycle, and delivery latency.
The work around that path is missing:

1. **Change-feed routing.** When Postgres reports a change, turning it into "these resources
   must recompute" happens with no timing at all (`database/change-feed`: `listener.ts:106`
   → `routeChange` in `route-change.ts:24` → `applyDbChange`).
2. **The HTTP fallback `GET /api/resources/:key`.** This is a raw route
   (`server-core/bin/index.ts:148`), so it has no `http` span. Its loader does nest under a
   `sub` origin (`gatedRead`, `runtime.ts:1778`). But the revalidate/ETag check runs before
   `gatedRead` (`runtime.ts:4450-4468`), outside any span. So a 304 records nothing, and
   the signature queries it runs show up in Slow Ops with no parent.
3. **Delivery.** `onDelivered(key, latencyMs, subscribers)` (`runtime.ts:3781`, `3049`,
   `3386`) is given the subscriber count. `server-core/core/resources.ts:231` then throws it
   away. The frame is serialized once, in `broadcastJson` (`runtime.ts:2411`), but its size
   never leaves that function.
4. **Loader labels.** `wrapLoad(key, fn)` (`runtime.ts:950`, one call site `timedLoad`
   `:1577`) never sees the params. So every param set of a resource folds into one row.
5. **Membership queries.** The window ids query (`membership.windowIdsOf`,
   `runtime.ts:3238`/`3294`) runs directly under a `push` origin, not under a named span of
   its own. Its db span looks like any other query of that resource.

The goal: if a change is slow because it is stuck in routing, in the HTTP fallback, or in a
huge fan-out, you can find it from Debug → Slow Ops and `get_runtime_profile`.

## Design

### A. Spans can carry a variant and numeric measures (the enabling primitive)

Today a span is only `(kind, label, duration)`. Params cannot go into the label: the
convention is that a label is a bounded identifier (`recorder.ts:239` caps its length only),
and a label per param set would create a new row per conversation id. So spans get an
optional **detail**:

```ts
// runtime-profiler/core/recorder.ts
export const SPAN_MEASURES = ["subscribers", "frameChars", "ids", "sinceChangeMs"] as const;
export type SpanMeasure = (typeof SPAN_MEASURES)[number];
export interface SpanDetail {
  /** Which instance of the operation, e.g. a loader's canonical params. Capped at 200 chars. */
  variant?: string;
  measures?: Partial<Record<SpanMeasure, number>>;
}
recordEntrySpan(kind, label, fn, detail?)   // added last, optional
recordSpan(kind, label, ms, detail?)
```

- The measure names are a closed list, the same way `SPAN_KINDS` is. A typo is a tsc error,
  and the UI can label and format each measure.
- `SlowSpan` gets `detail?: SpanDetail`. `Aggregate` gets `measuresMax` (the largest value
  of each measure in the window), so `get_runtime_profile` shows "largest frame / widest
  fan-out" even when no single span was over the threshold.

**Slow Ops store** (`debug/slow-ops`, fields declared in `core/resources.ts` `slowOpFields`):
- New `variants: VariantBreakdown[]` column: `{variant, count, totalMs, maxMs}`, merged like
  `callers` (`record-slow-op.ts:85` `mergeCaller`). It keeps the top 10 by `totalMs` and
  folds the rest into one `(other)` entry, so a row cannot grow without bound.
- New `measures: Partial<Record<SpanMeasure, {max, last}>>` column.
- `recentSamples` entries also carry the sample's `variant` and `measures`.
- The migration comes from `./equin build`.

A resource stays **one row**, and that row lists which param sets were slow. This keeps the
row count bounded while still answering "which params".

**UI:** the single-worktree pane (`slow-ops/plugins/pane/.../slow-ops-view.tsx`) renders
`VariantBreakdownLines` next to the existing `CallerBreakdownLines`, plus the row's
measures as labelled values. The cluster tab's `buildClusterAggregate` (`cluster/web/internal/aggregate.ts`)
takes the largest value of each measure across worktrees. It does not merge variants.

### B. Two new span kinds: `route` and `membership`

Both are added to `SPAN_KINDS` (`recorder.ts:83`). Every `Record<SpanKind, …>` literal then
fails tsc until it is filled in: `ORIGIN_CLASS` and the per-kind aggregate maps.

- `route`: background lane (it is a root). Slow threshold: the loader threshold, so no new
  config setting. A new setting would lower the perf floor for every span.
- `membership`: background lane. It is never a root, because it only runs under `push`.
  Threshold: the loader threshold. Keeping it out of `loader` has a reason: a loader
  label feeds the loader→tables read-set index. `cascade` was split out for the same reason.

### C. Wiring each gap

| Gap | Change | Where |
|---|---|---|
| Change-feed routing | Around `opts.route(change)`: `recordEntrySpan("route", change.table, …, {measures: {ids: change.ids?.length, sinceChangeMs: now − changedAt}})`. `sinceChangeMs` is left out when `changedAt` is null. The duration is the synchronous routing work. `sinceChangeMs` is the time from the trigger firing to routing: event-loop delay plus how long the transaction stayed open. It is a measure, not the duration, because it includes transaction time, which is not routing's fault. | `change-feed/server/internal/listener.ts:106-118` |
| HTTP fallback | New runtime option `wrapHttp?(key, fn)`. `handleResourceHttp` calls it right after the key is found in the registry, and it wraps everything after that, including the ETag/304 path. The server binds `recordEntrySpan("http", \`GET /api/resources/${key}\`, fn)`. The label is bounded because it only uses registered keys; an unknown key 404s before the wrap. Central passes no option, so nothing changes there. Update the `ORIGIN_CLASS.sub` comment that describes this route. | `runtime.ts:4431`, `server-core/core/resources.ts` |
| Delivery | `broadcastJson` returns `str.length` → `sendUpdate` passes it on → all three `onDelivered` sites pass `frameChars`. The server records `recordSpan("push", \`deliver:${key}\`, ms, {measures: {subscribers, frameChars}})`. `ResourceDeliveryObserver` also gets `frameChars`. The number is characters, not bytes, because `Buffer.byteLength` would re-scan every frame on the flush path. The name says so. | `runtime.ts:2411`, `1872`, `3049`, `3386`, `3781`; `resources.ts:226-233` |
| Loader params | Widen to `wrapLoad?(key, info: {variant?: string; scopedIds?: number}, fn)`. `timedLoad` computes `variant = paramsKey(params)`, or leaves it undefined for `{}`, and `scopedIds = ctx?.affectedIds?.length`. The server binds `recordEntrySpan("loader", key, fn, {variant, measures: {ids: scopedIds}})`. A scoped refill is then the rows that have `ids`. The label stays the key, so `loaderStats` (`resources.ts:249`) is unchanged. | `runtime.ts:950`, `1577`; `resources.ts:219` |
| Membership | New runtime option `wrapMembership?(key, fn)`, used inside both `windowIdsOf` call sites, within the existing `push` origin. The server binds `recordEntrySpan("membership", key, fn)`. Point membership (`idsOf`, `:4899`) is pure and runs no query, so it is not wrapped. | `runtime.ts:3236-3240`, `3292-3296` |

Every new runtime hook is optional and does nothing when absent, matching `wrapLoad` and
`wrapOrigin`. So central's runtime behaves exactly as before.

### D. Docs

- `infra/runtime-profiler/CLAUDE.md`: span detail, `SPAN_MEASURES`, and the two new kinds.
- The `get_runtime_profile` MCP description (`debug/profiling/.../mcp-tools.ts:56`): the new
  kinds, `measuresMax`, and the `http GET /api/resources/<key>` entry.
- `resource-runtime/CLAUDE.md`: the widened `wrapLoad`, `wrapHttp`, `wrapMembership`, and
  `frameChars`.
- `change-feed/CLAUDE.md` and `slow-ops/CLAUDE.md`: note the new route span and the new
  columns.
- `docs/plugins-*` regenerate during build.
- After the work lands, add a note under the audit page's §10.4 saying the gaps are closed.

## Files

- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` (+ `index.ts`, `recorder.test.ts`)
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (+ tests)
- `plugins/framework/plugins/server-core/core/resources.ts`
- `plugins/database/plugins/change-feed/server/internal/listener.ts` (+ test)
- `plugins/debug/plugins/slow-ops/core/resources.ts`, `server/internal/record-slow-op.ts`,
  `install-slow-span.ts`, `resolve-threshold.ts`, `plugins/pane/web/…`, `plugins/cluster/web/internal/aggregate.ts`
- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`

## Verification

- Unit tests (`./equin test <plugin>`):
  - recorder: detail reaches `SlowSpan` for both kinds of span, and `measuresMax` is
    computed.
  - slow-ops: variant merging keeps the top 10 and folds the rest into `(other)`.
  - resource-runtime: `wrapLoad` gets the variant and `scopedIds`; `wrapHttp` wraps a 304;
    `wrapMembership` wraps a window refill; `onDelivered` gets `frameChars`.
  - change-feed: the listener records a `route` span.
- `./equin build` (generates the slow_ops migration), then `./equin check`.
- Live check against this worktree's deploy:
  - `get_runtime_profile` shows `route` rows (one per table), `membership` rows, an
    `http GET /api/resources/<key>` row after a WS-invalidate refetch, and
    `measuresMax.subscribers` / `frameChars` on `push deliver:*`.
  - Temporarily set the loader threshold to 0 in Settings → Config. Debug → Slow Ops should
    then show variant lines on loader rows and measures on deliver rows. Restore the
    threshold afterwards.
