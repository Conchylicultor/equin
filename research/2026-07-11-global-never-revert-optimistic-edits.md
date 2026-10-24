# Never-revert optimistic edits: causal ack-token confirmation, no eviction, no rollback

## Context

A user typing in the Page editor saw their edits vanish mid-typing. Root cause (confirmed
by an `optimistic-divergence` report on the exact page, `pageId: block-1783508240248-6o4jvk`,
opSummaries `["split"]`): the optimistic-mutation primitive evicted a server-acked `split`
op after `DIVERGENCE_MISS_LIMIT = 3` pushes failed to reflect it. Under main's push lag
(multi-second `deliver:page-blocks`, live-state missed-update wedges), those three pushes
were **stale snapshots computed before the split committed** — the eviction heuristic counts
delivery order, not causality. Dropping the op reverted the rendered page to a base without
the user's new block.

Design principle (user-stated, matching Docs/Figma/Linear/Notion local-first semantics):
**pending local edits are never visually reverted**. Reconciliation is replay onto new server
truth; an op leaves the overlay only for a *causal* reason (provably absorbed or provably
superseded); failure is a sync-status state (cloud icon), not an undo. The repo already
implements exactly this policy in the CRDT text lane
(`plugins/page/plugins/editor/web/internal/live-state-yjs-provider.ts` — offline is
`syncing`, bytes buffer + retry push-based, never lost); this change brings the structural
lane (`useOptimisticResource`) to parity.

Three changes:
1. **Causal (ack-token) confirmation** — mutation endpoints return their commit's xid8;
   live-state frames carry a snapshot watermark; snapshots can confirm any time (content
   match is always safe) but can **deny** an op only when causally at-or-after its commit.
2. **No miss-limit eviction** — tokenless ops are never evicted (divergence becomes a
   report-only signal); token-carrying ops drop only when a causally-later snapshot lacks
   their effect (genuinely superseded — rendering newer truth, not a revert).
3. **No rollback on mutate failure** — network failure: keep op rendered, phase `syncing`,
   auto-retry on reconnect edges. Durable HTTP rejection (`EndpointError`): keep op
   rendered, phase `error` + Retry. `removeOp`-on-reject is deleted.

## Soundness rules

- **Rule A (ack token):** `pg_current_xact_id()::text` read *inside the write transaction*
  (free — the write already assigned the xid). xid8 decimal text; compare as BigInt.
- **Rule B (snapshot watermark):** `pg_snapshot_xmin(pg_current_snapshot())` captured
  **before** a loader read is a valid floor: `xmin > commitXid` ⇒ that read saw the commit
  (or its overwrite). A snapshot may **deny** an op only under strict `>`.
- **Rule B′ (which frames carry a watermark):** only frames whose value fully reconciles
  the client to server truth as of the capture — `sub-ack`, `update`, FULL keyed deltas,
  HTTP body. **Scoped deltas never carry one** (they re-read only affected rows; stamping
  would let a client wrongly deny). Twin of the existing "etag rides only `update`" rule.
  Watermark is captured inside the single-flight by the starter (joiners adopt the
  starter's value+watermark pair) — watermark-newer-than-value is structurally excluded.

## Implementation steps (repo builds at each step)

### 1. `live-state/core` — shared comparator
- New `plugins/primitives/plugins/live-state/core/watermark.ts`:
  `compareTxWatermark(a: string, b: string): -1 | 0 | 1` (BigInt). Barrel export.
  Co-located bun:test.

### 2. Server runtime — watermark on the wire
All in `plugins/framework/plugins/resource-runtime/core/runtime.ts`, reusing the existing
`opts.captureWatermark` hook (bound in `server-core/core/resources.ts:249-256`; central has
no hook ⇒ degrades to tokenless cleanly):
- `getResourceValue` (:1184): flight result widens to `{value, etag, watermark}`; capture
  before `timedLoad` in full-flight arms only (scoped ctx path ⇒ undefined), try/catch →
  `reportLoaderError` + undefined. Joiners adopt via existing inflight coalesce.
- `gatedRead` (:1235): pass-through.
- `sendUpdate` (:1320): optional `watermark` param, conditional-spread (preserve H5a
  no-await-before-send).
- `drainEntry` (:2189): thread flight watermark into `sendUpdate` calls + the FULL keyed
  delta literal; scoped delta gets NONE.
- `drainMembershipFull` (:1963): thread into update + delta. `drainMembershipScoped`
  (:2053): NONE.
- `serveSub` (:2611): watermark on the sub-ack literal. `up-to-date` frames: none.
- `handleResourceHttp` (:2951): body `{value, version, watermark?}`.
- New `runtime-watermark.test.ts` mirroring `runtime-version-shortcircuit.test.ts`
  (harness gains a `captureWatermark` option): full frames carry it, scoped/up-to-date
  don't, HTTP does, throwing capture still delivers, joiner adopts starter's.

### 3. Client transport — adopt + expose
In `plugins/primitives/plugins/live-state/web/`:
- New `watermark-registry.ts`: module-level map keyed `${key}\0${paramsKey}`;
  `noteResourceWatermark` (monotonic adopt via comparator), `getResourceWatermark`.
  Barrel-exported. Module-level so the optimistic hook + jsdom tests read it without a
  `NotificationsProvider`.
- `notifications-client.ts`: `ServerMsg` gains `watermark?` on sub-ack/update/delta;
  `handleServerMessage` notes it after the version guard, **before** any `setQueryData`
  (the optimistic hook reads the registry synchronously inside QueryCache callbacks).
  `fetchOverHttp`: note after the strict-`<` guard, before `setQueryData`.
- Cross-tab: zero work — `SharedWebSocket` rebroadcasts raw frames
  (`shared-websocket.ts:212`), each tab parses and populates its own registry.
- Extend `web/__tests__/notifications-subs.test.ts`.

### 4. `database/server` — `currentTxId`
- New `plugins/database/server/internal/current-tx-id.ts`, barrel export:
  `currentTxId(exec): Promise<string>` — `SELECT pg_current_xact_id()::text`. Handlers pass
  their `tx`. DB-backed test (db-test-fixture): monotonic across transactions; comparable
  with `captureWatermark`'s xmin (pins Rule A↔B on real Postgres).

### 5. Primitive rewrite — `plugins/primitives/plugins/optimistic-mutation`
**`web/internal/overlay.ts`** (pure machine):
- `PendingOp` gains `ackWatermark?`, `failure?: {kind:"network"} | {kind:"http"; status}`,
  `divergenceReported: boolean`; keeps `dispatchGen` (tokenless coarse) and `misses`
  (report trigger only). `ReconcileResult` → `{pending, dropped, stalled}`.
- `DIVERGENCE_MISS_LIMIT` → `DIVERGENCE_REPORT_MISSES = 3` (report-once latch, never evicts).
- `confirmPass(pending, serverData, snapshotWatermark, confirmation?)`: confirm =
  content `isConfirmedBy` (any snapshot) | coarse+token `cmp(snapshotWm, ackWm) > 0` |
  coarse tokenless legacy. **Denial** (content mode only): resolved + unconfirmed +
  non-cascaded + has token + `cmp > 0` → `dropped` (superseded; report). Everything else
  survives; miss-threshold crossers → `stalled` (kept). Failed ops are unresolved ⇒
  untouchable by confirm/cascade/denial.
- `resolvePass(..., snapshotWatermark, ackWatermark, ...)`: stamps token, clears failure;
  no denial, no miss on this edge.
- Delete `removeOp`; add `markFailed` / `clearFailure`.

**`web/internal/use-optimistic-resource.ts`** (shell):
- `mutate` widens to `(vars) => Promise<void | { watermark?: string }>` (backward-compatible).
- Reject: classify `err instanceof EndpointError` (from `@plugins/infra/plugins/endpoints/web`)
  ⇒ http, else network; `markFailed` — **no removal**. `onError` still fires.
- Stable `runMutate(opId, vars)`; `retry(opId)` = `clearFailure` + re-fire **in place**
  (same opId/position). `failed` becomes the derived HTTP-failed subset (same shape).
- Auto-retry effect (mirrors `live-state-yjs-provider.ts:246-255`): `subscribeWsStatus`
  (`networking/web`) filtered `status==="open" && liveStateSocketKind(url)` matches the
  resource origin, plus `window "online"` — both retry all network-failed ops. No timers,
  no per-push retry.
- Phase: `anyHttpFailed ? "error" : saving ? "syncing" : "idle"` (network-failed ops are
  unresolved ⇒ syncing). No sync-status plugin changes.
- Cache subscription passes `getResourceWatermark(...)` into `confirmPass`.

**`web/reporter.ts`**: payload gains `kind: "superseded" | "stalled"`.

**Tests**: rewrite `overlay.test.ts` miss/rollback suites (stalled-report-only, causal
denial, coarse token, failed-op immunity, cascade never drops unresolved); rewrite
`__tests__/use-optimistic-resource.test.tsx` (keep-rendered on both reject kinds,
`online`-event auto-retry, superseded drop + sink kind); extend `args-types.test.ts`.

### 6. Reports plugin — `reports/plugins/optimistic-divergence`
- Schema + fingerprint gain `kind` (misses/params stay excluded); collector forwards it;
  `server/internal/optimistic-divergence-task.ts:29-83` copy rewritten per kind
  (superseded = healthy newer-truth drop; stalled = still rendered, investigate).

### 7. Consumers (endpoints return the token; handlers call `currentTxId(tx)` in-transaction)
- **Page editor**: `applyBlockOpEndpoint` + `patchBlocks` response schemas gain
  `watermark: z.string()`; `handle-apply-block-op.ts` / `handle-patch-blocks.ts` capture
  inside their existing `db.transaction`; `web/block-store.ts:130-133` mutate returns
  `{watermark: r.watermark}`.
- **config_v2 staging**: `stageConfigDefault` (+ discard if optimistic) same treatment;
  wrap single-statement writes in `db.transaction`.
- **Queue reorder**: `reorderQueue` same; wrap upsertRank/reseat in one transaction. Both
  coarse consumers return the token (upgrades them to exact causal coarse confirmation).

### 8. Docs
`optimistic-mutation/CLAUDE.md` (failure model, Rules A/B/B′), `live-state/CLAUDE.md`
(commit watermarks), `resource-runtime/CLAUDE.md` (watermark twin of the etag rule),
`reports/optimistic-divergence/CLAUDE.md`, `page/editor/CLAUDE.md` (stuck-inverse note).

## Boundary check
New barrel exports: `database/server` (`currentTxId`), `live-state/core`
(`compareTxWatermark`), `live-state/web` (`getResourceWatermark`, `noteResourceWatermark`).
New edges: optimistic-mutation → endpoints/web + networking/web (both acyclic leaves).
No cross-plugin re-exports; resource-runtime gains no imports (injected hook).

## Risks / accepted residue
- Long-lived transactions pin xmin → delayed confirmation/denial; never unsound.
- Scoped-delta-heavy resources: denial may wait for the next full frame; stalled report
  preserves observability.
- Failed-op retry lands last server-side but replays at original position — same class as
  today's out-of-order acks; content confirmation + cascade absorb it.
- Fetch fails while WS never cycled and browser never went offline: op sits in `syncing`
  until the next edge or manual Retry — same residue as the Yjs provider.
- Tab closed while offline loses unflushed ops — same class as unflushed autosave (Yjs
  lane has the identical bound).

## Verification
1. `bun test plugins/primitives/plugins/live-state/core plugins/primitives/plugins/optimistic-mutation/web/internal plugins/framework/plugins/resource-runtime/core`
   (comparator, overlay machine, runtime watermark + existing H5/etag suites stay green).
2. `bun test plugins/database/plugins/live-state-snapshot` + the new `current-tx-id` test
   (needs the running cluster) — Rule A↔B comparability on real Postgres.
3. `bun run test:dom plugins/primitives/plugins/networking plugins/primitives/plugins/live-state plugins/primitives/plugins/optimistic-mutation`.
4. `./equin check` (type-check sweeps every consumer of the widened types), then
   `./equin build`.
5. Manual e2e (the motivating bug) at `http://<worktree>.localhost:9000` in the Pages app:
   (a) rapid type+Enter under push churn (Debug → Live-State Emit): the split block must
   never vanish; (b) kill the backend mid-typing: cloud `syncing`, edits stay rendered; on
   restart the queued mutates retry and the cloud lands on Saved (`bun e2e/screenshot.mjs`
   before/after); (c) force a durable 4xx on the patch endpoint: cloud `error` + Retry,
   block still rendered, Retry converges.
6. Artificially break `isConfirmedBy`: exactly one `stalled` report files (Debug →
   Reports) and the op stays rendered throughout.

## Addendum (2026-10-08): permanent rejections leave the overlay

Change 3 ("No rollback on mutate failure") is narrowed. Never-revert protects
predictions whose outcome is UNKNOWN (network loss, push lag, unproven
divergence). A permanent HTTP rejection — any 4xx but 401 / 408 / 429
(`classifyRejection`) — is a KNOWN, final verdict: keeping the op rendered showed
a state the server refused to hold, parked every same-target junior behind it,
and lost the edit silently on reload. Such an op now leaves the overlay at once
and is reported (error toast + `optimistic-rejection` report); transient failures
(network, 5xx, 401, 408, 429) keep the behaviour above. See
`research/2026-10-08-global-rejected-optimistic-ops.md`.
