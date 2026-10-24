# Optimistic-mutation: fix the stuck sync-status spinner, and make "Saved" mean something

## Context

The sync-status cloud (`<SyncStatusIndicator/>`, mounted once per surface in `TabSurface`)
spins forever after any page edit, even though the data is saved. Reloading or opening
another tab shows the correct content.

**Root cause (measured, not inferred).** I instrumented `fetch` and `WebSocket` in a live
browser and typed one character into a block:

```
     0 ms   fetch SENT  /pages/…/blocks/patch
    83 ms   WS PUSH page-blocks (→ confirmPass runs)
    84 ms   fetch RESOLVED (mutate .then → markResolved)
```

The confirming push **is** delivered — 1 ms too early. `confirmPass` only ever runs from the
QueryCache subscription (`use-optimistic-resource.ts:127-141`), and it only drops an op that
is already flagged `resolved`. `resolved` is set by `mutate().then(...)`. So the one push an
edit generates inspects the op, sees `resolved: false`, keeps it — and nothing ever re-asks.
The op is stranded in `pending` forever.

This ordering is **structurally biased, not a coin flip**: the push is emitted by the L4 DB
change-feed at transaction commit, while the HTTP response is only written after the handler
awaits `notifyStructuralChange`, re-`SELECT`s every block on the page, `BlockSchema.parse()`s
each row, and serializes. The WS frame gets that whole post-commit tail as a head start.

A second probe confirmed the op is saved and confirmable the whole time: tab A stayed
`syncing` indefinitely, then flipped straight to `saved` the instant tab B's unrelated edit
produced a push.

**Three consequences:**

1. `phase` is derived from `inFlight.length`, which counts *every* overlay op including
   server-acked ones ⇒ the spinner never stops and `savedAt` is never stamped.
2. The stranded op stays in the replay fold. It's invisible today only because
   `applyOverlayOp` sees the base already reflects it and throws `OpNoLongerApplies`. If
   another tab or an agent later **deletes or moves that block**, `isReflected` goes false and
   the zombie op re-applies — resurrecting a deleted block, locally, forever.
3. Coarse-mode consumers (both conversation queue-reorder views) hit the identical bug.

**Not covered today at all:** the Yjs `doc-update` pipeline — where the actual prose lives —
never calls `useReportSync`. The permanently-spinning cloud accidentally masks this. Fixing
the indicator *creates* the lie ("Saved" while bytes sit in a 300 ms debounce), so it must be
fixed in the same change.

**Intended outcome.** One overloaded signal (`pending`) is split into three well-defined ones:
*saving* (server hasn't acked), *overlay GC* (can I stop predicting?), and *divergence* (the
server durably disagrees). The cloud reads the first, `confirmPass` drives the second, and the
third becomes a loud report instead of an unobserved condition.

---

## Design

### 1. Move the op lifecycle into a pure state machine (`overlay.ts`)

Today `overlay.ts` is pure and well-tested; the React shell holds the lifecycle and is
untested. Invert that: the shell becomes trivial, the lifecycle becomes `bun:test`-able.

`PendingOp<Vars>` grows two fields:

```ts
export interface PendingOp<Vars> {
  opId: string;
  vars: Vars;
  resolved: boolean;
  /** Cache generation (dataUpdateCount) observed at dispatch. Coarse confirmation only. */
  dispatchGen: number;
  /** Consecutive authoritative pushes since resolve that did NOT confirm this op. */
  misses: number;
}
```

Two edge functions, both returning `{ pending, diverged }`:

- **`confirmPass(pending, serverData, confirmation)`** — the push edge. Existing semantics
  (coarse: drop resolved; content: drop confirmed + same-target cascade), plus: a surviving
  resolved-and-unconfirmed op gets `misses + 1`. Cascade-dropped ops never count as diverged
  (being superseded is expected). Ops reaching `DIVERGENCE_MISS_LIMIT` (3) are removed from
  `pending` and returned in `diverged`.
- **`resolvePass(pending, opId, serverData, gen, confirmation)`** — the resolve edge. Marks
  resolved, then attempts confirmation **immediately**:
  - *content-based*: confirm iff `serverData !== undefined && isConfirmedBy(serverData, vars)`.
    On confirm, run the same same-target cascade. No miss counted (no new snapshot arrived).
  - *coarse*: confirm iff `gen > op.dispatchGen` — i.e. an authoritative push landed since
    dispatch. **This is the fix for the two coarse consumers.**

Shared helper `dropConfirmed(pending, confirmedFlags, sameTarget)` so the cascade lives in one
place.

**Coarse soundness, stated explicitly.** `gen > dispatchGen` proves *a* push arrived after
dispatch, not that it carries our commit. In the rare bad ordering (a push generated
pre-commit, delivered post-dispatch) the op drops early and the UI briefly reverts until the
real push lands — which is *guaranteed* to arrive, since the write committed. Bounded and
self-healing; never a permanent zombie. This is the accepted trade-off (chosen over migrating
the two coarse consumers to content-based, which stays available later).

`DIVERGENCE_MISS_LIMIT = 3` is safe because every write to the key generates a push for that
key: by the third post-resolve push, our own commit is long visible.

### 2. `phase` from unresolved ops

```ts
const saving = pending.some((op) => !op.resolved);
const phase = failed.length ? "error" : saving ? "syncing" : "idle";
```

`savedAt` is stamped **inside the resolve handler**, from `resolvePass`'s result, when no
unresolved ops remain and `failed` is empty — not from an effect on a derived boolean. A
persistent state value can't be coalesced away (this is the exact hazard `sync-status`'s
CLAUDE.md documents about the old `syncing → idle` inference).

Consequences worth stating: a save round-trips in ~85 ms, under the indicator's 120 ms
show-delay ⇒ the spinner mostly stops appearing at all, going straight to "Saved". And with
the WebSocket down, every save currently spins forever despite being persisted; deriving from
`resolved` removes that whole failure mode.

The returned `inFlight` is a misnomer (it contains acked ops). Rename to `pendingOps` and add
`saving: boolean`. **No consumer reads `inFlight` today** (verified), so this is free.

### 3. Divergence detector → a report, not a spinner

`optimistic-mutation` is a primitive and must not import `reports`. Use the sanctioned
inversion already used by `error-boundary` → `reports.crash`:

- **New** `plugins/primitives/plugins/optimistic-mutation/web/reporter.ts`:
  `optimisticDivergenceReportSink = defineReportSink<OptimisticDivergenceReport>()`, exported
  from the barrel. The hook `emit`s when `diverged.length > 0`.
  Payload: `{ resourceKey, params, label, misses, opSummaries }` — no raw `vars` (unbounded,
  possibly unserializable). `opSummaries` comes from a new optional
  `describeOp?: (vars: Vars) => string` arg; the page editor passes
  `v => v.tag === "patch" ? "patch" : v.op.kind`.
- **New plugin** `plugins/reports/plugins/optimistic-divergence/`:
  - `core/kind.ts` — zod payload schema + fingerprint (`resourceKey + label + opSummaries`,
    excluding volatile `misses`, so repeats collapse to one row).
  - `web/` — a Core.Root headless component registering the sink handler → `report({...})`,
    mirroring `reports/plugins/crash/web/components/crash-collector.tsx:40-59`; plus a
    `Reports.KindView` contribution for the Debug → Reports summary row.
  - `server/index.ts` — `ReportKind({ kind: "optimistic-divergence", schema, fingerprint,
    meta: { notifCooldownMs: 6h }, renderTask })`. Re-arms like `render-loop` (a still-present
    divergence is a warning, not a one-shot crash).
- Add `"client-optimistic-divergence"` to `CLIENT_REPORT_SOURCES`
  (`plugins/reports/core/sources.ts:17-27`).

Push-driven throughout — no timers, no polling.

### 4. The collab text seam reports its save state

Scope: the **`doc-update` pipeline only**. Once `doc-update` lands, the text is durable; the
~1 s `data.text` projection is derived denormalization (search, backlinks, doc seed) and its
lag is not user data at risk — and it dispatches through the optimistic pipeline anyway, which
now reports correctly.

`live-state-yjs-provider.ts` is already a class with `Set`-based listener registries
(`syncListeners`, `statusListeners`, `updateListeners`, `reloadListeners` at lines 165-168).
Add one more in the same idiom:

- `saveState: "idle" | "syncing" | "error"`, derived from
  `pendingUpdates.length > 0 || flushInFlight || flushTimer !== null` (⇒ `syncing`),
  `lastError !== null` (⇒ `error`), else `idle`. `blockGone` ⇒ `idle` (bytes deliberately
  dropped; content already moved by the merge).
- `lastFlushedAt: number | null`, stamped when the queue drains after having been non-empty.
- `onSaveState(cb): () => void`, and a memoized frozen `getSnapshot()` (stable identity unless
  something changed) so `useSyncExternalStore` doesn't loop.
- Emit at every transition point: `onDocUpdate` (:358-362), `scheduleFlush` (:364-373),
  `flushLoop` start / drain / catch (:381-443), `markSynced` (:546-559).

**Offline must not read as an error.** A network-level fetch rejection re-queues at the head
and retries push-based (socket reopen / `online` / next server push — `:419-435`, `:190-194`,
`:325-336`, `:532-544`). That stays `syncing`. Only a real non-409 `EndpointError` on flush
(`:422`) or a non-404 `EndpointError` on init (`:500`) sets `lastError` → `error`; the throw
still propagates (fail loudly). `retry` clears `lastError` and re-runs `flushLoop`.

Consumer: `CollabTextPlugin` (`collab-text-plugin.tsx:107`) is mounted exactly once per block
and already owns the per-block `useCollabBlockDoc` handle. It calls
`useReportSync({ phase, label: "text", retry, savedAt: lastFlushedAt })`. One reporter per
dirty block; the store aggregates (`error > syncing > saved > idle`).

---

## Files

**Modify**
- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts` — state machine
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts` — gen stamp, `resolvePass`, `phase`, `savedAt`, sink emit, `pendingOps`/`saving`
- `plugins/primitives/plugins/optimistic-mutation/web/index.ts` — export sink + types
- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.test.ts` — extend
- `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md`
- `plugins/primitives/plugins/sync-status/CLAUDE.md` — document what "Saved" now guarantees
- `plugins/reports/core/sources.ts` — add `client-optimistic-divergence`
- `plugins/page/plugins/editor/web/internal/live-state-yjs-provider.ts` — save-state listeners
- `plugins/page/plugins/editor/web/internal/use-collab-block-doc.ts` — expose the provider handle if not already returned
- `plugins/page/plugins/editor/web/components/collab-text-plugin.tsx` — `useReportSync`
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — pass `describeOp`
- `plugins/page/plugins/editor/CLAUDE.md`

**New**
- `plugins/primitives/plugins/optimistic-mutation/web/reporter.ts`
- `plugins/primitives/plugins/optimistic-mutation/web/__tests__/use-optimistic-resource.test.tsx`
- `plugins/reports/plugins/optimistic-divergence/{core,web,server}/index.ts` (+ `core/kind.ts`, `web/components/…`)

**Reuse (do not re-invent)**
- `defineReportSink` — `plugins/primitives/plugins/report-sink/core/internal/define-report-sink.ts:1-25`
- Sink-registration pattern — `plugins/reports/plugins/crash/web/components/crash-collector.tsx:40-59`
- Browser-side direct `report()` for a threshold-gated anomaly — `plugins/reports/plugins/render-loop/web/internal/render-loop-detector.ts:403-410`
- `ReportKind` server contribution — `plugins/reports/server/internal/report-kinds.ts:42-45`
- `queryKeyFor` — `plugins/primitives/plugins/live-state/web/notifications-client.ts:139-142`
- `queryClient.getQueryState(key)?.dataUpdateCount` — bumped on **every** `setQueryData`, verified in `@tanstack/query-core@5.99.0`
- Hook-test template — `plugins/primitives/plugins/data-view/web/__tests__/use-server-data-source.test.tsx`

No registry edits: `./equin build` regenerates from the filesystem.

---

## Verification

1. **Pure lifecycle** — `bun test plugins/primitives/plugins/optimistic-mutation`
   New cases: push-before-resolve confirms at the resolve edge; coarse gen stamp
   (`gen > dispatchGen` confirms, `gen === dispatchGen` keeps); miss counting; divergence at
   the 3rd miss drops the op and reports it; cascade-dropped ops are not reported as diverged;
   existing cascade / inverse-pair tests still pass.

2. **Hook shell** — `bun run test:dom plugins/primitives/plugins/optimistic-mutation`
   `renderHook` + `QueryClientProvider`: `setQueryData` (the push) *before* resolving a
   deferred `mutate` promise, then assert `saving === false`, `pendingOps` empty, `savedAt`
   stamped. *Risk:* `useResource` may need a `NotificationsProvider` to mount headless. If it
   can't run cheaply, drop this file — the lifecycle now lives in the pure machine, which is
   where the coverage belongs.

3. **`./equin build`**, then re-run the two probes already written:
   - `scratchpad/spinner-probe.mjs` — expect `A: t=1500ms after edit = saved` (was `syncing`
     at every sample), and tab B likewise `saved` after its own edit.
   - `scratchpad/ordering-probe.mjs` — expect the push still lands ~1 ms before the resolve
     (that ordering is not what we're changing), but no stuck state results.

4. **Offline honesty** — DevTools offline, type into a block: cloud shows `syncing` (not
   `error`), bytes queue; go online: flushes and flips to `Saved`.

5. **Divergence path** — covered by the pure tests. End-to-end, confirm the kind renders:
   Debug → Reports shows an `optimistic-divergence` row when one is filed
   (`query_db: select kind, count, fingerprint from _reports where kind = 'optimistic-divergence'`).

6. **`./equin check`** — `plugin-boundaries` (primitive must not import `reports`),
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`.

---

## Out of scope (deliberately)

- Migrating the two coarse consumers to content-based confirmation. The gen stamp fixes their
  stuck overlay; tightening their soundness is a separate, optional change.
- The ~1 s `data.text` projection dirty window. The doc is durable before it runs.
- A read-your-writes version token on mutation responses, which would make coarse confirmation
  fully sound. Correct fix, much larger blast radius (every mutation endpoint).
