# Rejected optimistic ops: drop, toast, report

## Context

When the server permanently rejects a page edit (an HTTP 4xx, not a network failure), the edit
fails silently:

- `useOptimisticResource` marks the op `failure: {kind:"http"}` and keeps it in the overlay
  (`markFailed`, `optimistic-mutation/web/internal/overlay.ts:643`). This is the "never-revert" rule
  from `research/2026-07-11-global-never-revert-optimistic-edits.md` §3.
- The op is never auto-retried. It renders forever and parks every newer same-target op behind it.
  The example from the issue is a collapse that "did nothing": the stuck op kept re-applying the
  expanded state.
- The only signal is the sync cloud's error tooltip, "Couldn't save — click to retry". There is no
  toast.
- There is no report. `EndpointErrorReporter`
  (`reports/plugins/endpoint-errors/web/components/endpoint-error-reporter.tsx`) deliberately skips
  any 400 that is not a schema-validation failure, plus 401/403/404/409.
  `optimistic-divergence` covers only server-acked ops.
- A reload discards the op, because the overlay is plain `useState`. The user's edit disappears with
  no explanation.

The detached writes in `composite-block-store.tsx` are worse off:

- The cross-page `moveAcrossPages` (:308) and the detached patch for a collapsed page (:373) are
  `void enqueueResourceWrite(...)`.
- They have no overlay and no sync-status hook.
- A 4xx on either one is visible only as a browser-rejection report, if the global handler catches
  it at all.

The never-revert policy was written for **unknown** outcomes: network loss, push lag, and
causally-unproven divergence. In those cases keeping the prediction is right. A 4xx is the
opposite: a **known, final** verdict that the server will never hold this state.

- Keeping the op rendered tells the user something that is not true.
- Retrying it only repeats the verdict.
- Showing server truth after a definite rejection is not a revert in the policy's sense. It is the
  same as the policy's own "superseded" drop: the op leaves for a causal reason.

**Outcome:**

- A permanently rejected op leaves the overlay at once, so the page shows what the server holds and
  later ops unpark.
- The user gets a toast saying the edit was not saved, with the reason.
- One report lands in Debug → Reports.
- Transient failures (network, 5xx, 401/408/429) keep today's behaviour: the op is kept and
  retried.

## Design

### 1. Failure classification (primitive, pure)

Add `classifyRejection(status): "permanent" | "transient"` in `optimistic-mutation/web/internal/`.
Make it the single rule:

- **permanent**: any 4xx except 401 (session; Retry after re-auth succeeds), 408 and 429.
- **transient**: 5xx, 401, 408, 429.

`OpFailure` stays `{kind:"network"} | {kind:"http"; status}`. Only transient HTTP failures can now
be stored as `http`, because a permanent one never stays in the overlay.

### 2. `useOptimisticResource`: drop permanent rejections

In the `runMutate` reject arm (`use-optimistic-resource.ts:~585`):

- If `err` is an `EndpointError` and `classifyRejection(err.status) === "permanent"`, then:
  - Call a new pure `rejectOp(pending, opId)` in `overlay.ts`, next to `markFailed`, and remove
    `removeOp`'s ghost in its doc. It removes that op only. Newer ops are not cascaded: each newer op
    is on the same lane and gets its own verdict. If a newer op depended on the rejected one, the
    server rejects it too and it drops the same way.
  - Emit `optimisticRejectionSink` (new, in `optimistic-mutation/web/reporter.ts`, next to
    `optimisticDivergenceReportSink`) with bounded coordinates:
    `{resourceKey, params, label, status, message, opSummary}`.
    - `message` comes from `getEndpointErrorMessage(err)`.
    - `opSummary` comes from the consumer's existing `describeOp`.
  - Fire `onError(err, vars)` as today. Extend its info with the outcome, `{rejected: true}`, so a
    consumer can unwind its own side state (see §4).
  - Return a new outcome, `"rejected"`. The drain treats it like `http`: keep going.
- Otherwise, behaviour is unchanged: `markFailed`, with `network` meaning syncing plus auto-retry,
  and `http` meaning error plus Retry.

`retryOp` and the `retryAll` drain need no change: a rejected op is no longer in `pending`.

The overlay ordering rule ("no op leaves while an older same-target op is pending") does not apply
to rejection. A rejected op was never applied, so nothing newer can be confirmed against it.
`rejectOp` is a direct removal, not a `reconcile` verdict. Pin this in `overlay.test.ts`.

### 3. Detached writes join the same signal

`enqueueDetachedWrite(resource, params, { label, describe, onRejected? }, fn): void` — the
fire-and-forget twin of `enqueueResourceWrite` (which stays as is for callers that await the
outcome, e.g. sonata's `setTracksActive`):

- On `EndpointError` it emits `optimisticRejectionSink`, for any status, since there is no Retry
  surface for a detached write, then calls `onRejected`. A non-`EndpointError` is rethrown. This
  follows the `.catch(err => { if (err instanceof X) handle; else throw err })` pattern.
- Callers that ignored the outcome (`void enqueueResourceWrite(...)`) move to it:
  - `composite-block-store.tsx`: both `moveAcrossPages` arms and the detached patch.
  - `sonata/track-mixer/web/actions.ts`'s fire-and-forget `send`.

### 4. Page editor: unwind the undo entry

The rejected op's undo entry (`recordStructural`, `block-editor-context.tsx:1336`) brackets a state
that never existed. Undoing it would issue an inverse patch against server truth, giving either a
second rejection or an undo conflict. Fix:

- `dispatchOp` (:1603) already gets the opId back from `store.dispatch`. Stamp it on the recorded
  entry.
- `useServerBlockStore` (`block-store.ts:147`) passes an `onError` that, on `rejected`, calls an
  undo-stack `discardEntryForOp(opId)`. That removes the entry from undo and redo, wherever it sits.
  Entries above it stay: their own ops either succeeded independently or are rejected in turn.
- The composite store's `dispatch` returns the inner opId through `dispatchFor`.

Also pass `label: "Page"` so the cloud and toast name the surface.

### 5. Reports + toast collector

Add a new plugin `plugins/reports/plugins/optimistic-rejection/`, modelled on
`optimistic-divergence`, with the toast precedent taken from `mutation-errors`:

- `core/`: kind schema `optimistic-rejection` with fingerprint
  `(resourceKey, status, opSummary-kind, normalized message)`. Params are excluded from the
  fingerprint, so one task covers each distinct rejection shape.
- `web/components/optimistic-rejection-collector.tsx`: a `Core.Root` side-effect that registers the
  sink. Per emit it does two things:
  - `showToast({variant:"error", title: "Couldn't save <label>", description: message})`.
  - `void report({kind:"optimistic-rejection", source:"client-optimistic-rejection", …})`.
- Add `client-optimistic-rejection` to `CLIENT_REPORT_SOURCES` (`reports/core/sources.ts:57`).
- Add a `kind-view` component for Debug → Reports, plus the `server/internal/*-task.ts` copy:
  "server rejected an optimistic op with HTTP <status> — the client prediction or the endpoint's
  validation is wrong; investigate".

Why there is no toast in the primitive: `optimistic-mutation` must not import `reports` or `shell`.
The sink inversion is the established path.

### 6. Fix the vacuous e2e assertion

`page/editor/e2e/cross-page-selection-drop-verify.ts:151` asserts `getByText("Could not save")` is
absent. That text never renders (the real text is "Couldn't save"), so the assertion always passes.

- Add `data-sync-phase={aggregate.kind}` on the `SyncStatusIndicator` root.
- Assert `data-sync-phase` is not `error` and that no rejection toast is present.

The toast is `role="status"` via sonner, so match its title.

### 7. Docs

- Amend `optimistic-mutation/CLAUDE.md`'s failure model: a permanent rejection drops the op and
  emits; transient failures keep it.
- Add a dated addendum to the never-revert research doc, pointing to this doc.
- Add a `reports/optimistic-rejection/CLAUDE.md`.

## Critical files

- `plugins/primitives/plugins/optimistic-mutation/web/internal/{overlay.ts,use-optimistic-resource.ts,send-lane.ts}`
  and `web/reporter.ts`, `web/index.ts`
- `plugins/page/plugins/editor/web/{block-store.ts,composite-block-store.tsx,block-editor-context.tsx}`
  and the undo-history module
- `plugins/reports/plugins/optimistic-rejection/**` (new), `plugins/reports/core/sources.ts`
- `plugins/primitives/plugins/sync-status/web/components/sync-status-indicator.tsx`
- `plugins/page/plugins/editor/e2e/cross-page-selection-drop-verify.ts`
- `plugins/apps/plugins/sonata/plugins/track-mixer/web/actions.ts`

## Verification

**Unit tests**

- `overlay.test.ts`:
  - `rejectOp` removes only that op.
  - A parked newer same-target op becomes confirmable.
  - It works on an op with no failure.
- `use-optimistic-resource.test.tsx`:
  - A 400 reject drops the op: rendered data equals server truth, `failed` is empty, the sink is
    emitted once, and `onError` sees `rejected`.
  - 500, 401 and 429 keep today's error-plus-Retry behaviour.
  - Network failures are unchanged.
  - A drain over `[http-500, 400]` keeps going.
- Editor:
  - A rejected structural op's undo entry is discarded, so Cmd+Z skips to the previous entry.
  - A detached write's 4xx emits the sink.
- Collector test (like `page-undo-conflict/web/__tests__/collector.test.tsx`): one emit produces one
  toast and one `report()`.
- Run: `./equin test plugins/primitives/plugins/optimistic-mutation plugins/page/plugins/editor plugins/reports/plugins/optimistic-rejection`.

**End to end**

- Add `page/editor/e2e/rejected-op-verify.ts`. It forces a 4xx by routing
  `**/blocks/op` to a 400 with Playwright `page.route`, then collapses a block.
- Assert three things:
  - The block shows its server state.
  - The error toast appears and the cloud is not stuck in `error`.
  - A follow-up collapse on the same block works once the route is released.
- Check that the report row lands with `query_db` on the worktree DB's reports table.

**Build**

- `./equin build`, then a manual check at `http://<worktree>.localhost:9000`.
