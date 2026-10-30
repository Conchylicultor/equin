# Remove the duplicated client/server optimistic logic

Track: wiki "Sync engine" → Optimistic (block-6264cd85-3ec7-4d93-b746-16c0d81bd665).

## Context

The predicted-writes primitive (d41803d0f3, 715f1815ec) restates server writes in the browser:

- ~80 endpoint `effect`s in `core/` restate what their handlers write.
- The predict overlay re-sorts, re-filters and re-decodes live reads on its own.
- The Queue's `applyReorder` uses a different neighbour rule from the server's `rankAdjacentTo`.

These copies drifted, causing two crashes and several drift bugs. **Decision (user):** remove all duplicated logic. A "disable predictions" flag is not acceptable. Writes become non-optimistic, meaning server-confirmed and shown as pending, until a duplication-free system is designed (see the properties in the wiki page).

**Stays:**
- The page editor's `useOptimisticResource` over `applyBlockOp`. It is one `core/` reducer run on both sides.
- Its support code: the send lane, write sinks, `armUnconfirmedDeadline`, latency confirm samples, and the optimistic-rejection/-divergence reports.
- The tx-ack frames in resource-runtime and live-state.
- `agentWrite`, which predates the decision layer.
- `internal { why }`, which becomes an optional marker (user decision).

**Out of scope:**
- Data-view's in-memory sort.
- Data-view's generic `use-pending-move-overlay`, which is display-only. It holds a dropped row in place while the producer's `onMove` promise is in flight. It is already used by tasks, agents and page-tree moves.

## Plan

### 1. Callers: `useLiveMutation` → `useEndpointMutation` (76 files)

The pattern for each caller:

- `useLiveMutation(ep)` becomes `useEndpointMutation(ep)`.
- `mutate(req)` stays the same shape. Per-call `{ onSuccess }` maps onto TanStack's `mutate(vars, { onSuccess })`.
- The `needsMachine` union (`kind: "available" | "unavailable"`) is identical.

Fix-ups to audit per call site:

- **Pending must render** (CLAUDE.md "not-known-yet"). Where a `Button` triggers the write, hand it `mutateAsync(...)` so it auto-pends. Restore the pending states d41803d0f3 removed: Exit / Drop & Exit / push-and-exit Close and Restore, and EndThreadButton.
- **Continuous inputs** must not mutate per keystroke or drag against the live value. These are text fields and the like: config-field, notes-area, task-description, triage-note, song-title-field, rename-theme-dialog, page-header, tag-picker, the auth setup wizards and track-mixer. Each one must hold a local draft and commit on blur or release. Most already do; verify each one.
- **Unmount:** a write fired just before its component unmounts (close → navigate) puts follow-ups in the hook-level `onSuccess`, not per-call callbacks.
- **Mutation-only hooks** (`config_v2/web/internal/use-set-config.ts`, `tasks/web/client.ts`, `debug/queue` actions) switch the same way.

Representative callers:
- `plugins/apps/plugins/sonata/plugins/transpose/web/actions.ts`
- `plugins/apps/plugins/chord/plugins/curriculum/web/internal/use-curriculum.ts`
- `plugins/conversations/plugins/conversation-view/plugins/exit/web/components/exit-button.tsx`
- `.../push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/config_v2/plugins/settings/web/components/config-field.tsx`

### 2. Endpoint definitions: drop `effect` / `unpredicted` / `gap`

- Delete every `effect: (on) => …` (~90 in 53 files), `unpredicted: {…}` (~160 in 83 files) and `{ gap }` (2, page editor).
- Delete their imports, and any helper only an effect used (e.g. prototypes `PROTOTYPE_OPTIONS_REASON`; check each).
- Helpers shared with the handler stay; trim their "browser predicts" comments:
  - `browser/history/shared/visit-title.ts`
  - `chord/curriculum/core/change.ts`
- Remove `agentWrite: "telemetry"` as a "decision". The field stays.
- Rewrite the `reorderQueue` comment (`queue/core/endpoints.ts`).

### 3. `infra/endpoints`: back to one def shape (+ optional `internal`)

**Delete:**
- `core/endpoint-effect.ts`
- `core/prediction.ts`, except `InternalDecl`, which moves into `define-endpoint.ts`
- `core/commit-capture.ts`
- `lint/no-endpoint-effect-internals.ts` and its registration
- Tests: `prediction`, `predicted-types`, `decision-types`, `commit-capture`, `no-endpoint-effect-internals`

**Change `core/define-endpoint.ts`:**
- Drop `PredictedEndpointDef`, `PredictedMachineEndpointDef`, `endpointContractOf`, the `*Arm` / `Undecided` overloads and the runtime backstop (`DECISION_KEYS`, `resolveDecision`, …).
- Keep `InternalEndpointDef` / `InternalMachineEndpointDef`, with `internal?: undefined` on the plain defs so browser clients still refuse internal endpoints.
- The overloads become: plain def, or internal def. No write is required to declare anything.

**Strip commit capture:**
- `core/implement.ts`: the `predicted` commit-capture block.
- `web/internal/fetch-endpoint.ts`: `onCommits`.
- `database/server/internal/commit-capture.ts` (+ its test, the barrel exports and the driver.ts / `machine/internal/pg-driver.ts` hooks).
- `implement-machine.ts` and `call-endpoint.ts`: the effect plumbing.

**Finally:** fix the `core/index.ts` exports, then rewrite `endpoints/CLAUDE.md` (the effect/unpredicted section becomes a short `internal` paragraph).

### 4. `network/live`: delete the overlay

**Delete:**
- `core/internal/predict.ts`
- `web/internal/predict-overlay.ts`
- `web/internal/predict-reads.ts`
- `web/internal/use-predicted.ts`
- `web/internal/use-live-mutation.ts`
- Their tests (`predict*.test.ts`, `live-mutation-types.test.ts`, `predicted-writes.test.tsx`, `predicted-gaps.test.tsx`)

**Unfold the overlay from the reads:**
- `use-live.ts`: the value, all/ids, id-set and `useLiveRow` paths.
- `use-pages.ts`: `usePredictedFold`, `HeldTuples`, `held`.
- `use-live-reader.ts`: `predictValue`.

**Small cleanups:**
- Remove `pending` from `LiveRowResult`; tsc finds any reader.
- Remove send-lane pieces only predictions used: multi-key `enqueueOnSendLanes` and the lane override. `enqueueOnSendLane` / `resourceSendLaneKey` stay for optimistic-mutation.
- In the unconfirmed-deadline and latency-slow-op code, drop the `predict/<route>` variant naming. The mechanism stays for `useOptimisticResource`.
- Fix the `web/index.ts` and `core/index.ts` exports and remove the `exempt/index.ts` entry.

**Membership** (user decision: delete):
- Remove `membership` from `liveCollection` (`live-collection.ts` `LiveMembership` / `declaredMembership`, `live-fields.ts` `MembershipOf`, `serve-on.ts` refusal).
- Delete `server/internal/membership-sql.ts` + test, and the `andWhere` / `membershipSql` uses in `serve-collection.ts`, `serve-all.ts` and `serve-off-feed.ts`.
- Move the filters of conversations-active and -system back to a hand-written base `where` (`tasks-core/core/resources.ts` and server `conversation-rows.ts`, as before d41803d0f3).

**Docs:** delete CLAUDE.md "Predicted writes" (≈ l.330–457), the `membership` bullet and the `pending` line.

### 5. Queue reorder

- In `queue/web/components/use-queue-rows.ts`, replace `useOptimisticResource(queueRanks, …, { apply: applyReorder })` with `useLive(queueRanks, { ids })`.
- `onMove` (in `sidebar-queue.tsx`) returns `fetchEndpoint(reorderQueue, {}, { body })`'s promise. Data-view's pending-move overlay then holds the row until the ranks frame lands (display only; the server computes the rank).
- Delete `apply-reorder.ts` + test + its `queue/web/index.ts` exports.
- Drop `{ watermark }` from `reorderQueue`'s response if nothing else reads it.
- Update the comments in `queue/core/resources.ts`, the `use-pending-move-overlay.ts` doc and the queue CLAUDE.md files.

### 6. Routes facet / docgen

- `parse-utils/core/endpoint-exports.ts`: `RoutePrediction` / `predictionOf` shrink to an `internal` flag (+ test).
- `facets/plugins/routes/core/prediction.ts`: keep only the `internal` label in `renderRoute`. Delete `predictionDebt` / `renderPredictionDebt` + test.
- `codegen/core/docgen.ts`: drop the "Prediction debt by gap" section.
- `./equin build` regenerates `docs/plugins-details.md` and the per-plugin docs.

### 7. Tests

**Delete:**
- The per-endpoint effect tests (`readLiveEffect` assertions in ~30 `endpoints.test.ts` / `picks.test.ts` / `state.test.ts`). Where a file also tests something real, keep that part.
- `close-is-predicted`, `hold-is-predicted`, `rename-is-predicted`, `reset-is-predicted`.

**Update:**
- Component tests that mock `useLiveMutation`: bookmark-star, bookmarks-bar, end-thread-button, notifications-view, triage-card.
- Endpoint type tests: write-endpoint-types, implement, fetch-endpoint, needs-machine-types.

### 8. Wrap-up

- In the Sync engine page, add an agent-inline note under Optimistic: what was removed and what remains (the page editor's shared-reducer `useOptimisticResource`).
- File the next main task, "Design the duplication-free optimistic system", with the page id.

## Verification

- `./equin check`:
  - tsc catches every leftover `effect` / `useLiveMutation` / `pending` / `membership` use.
  - Lint and `plugins-doc-in-sync`.
  - `rg "useLiveMutation|readLiveEffect|PREDICTION_GAPS|endpointContractOf|membershipSql|applyReorder"` returns nothing.
- `./equin test` on the touched plugins:
  - network/live, infra/endpoints, conversations (queue, exit, push-and-exit), config_v2, page/editor (unchanged behaviour), facets/routes.
- `./equin build`, then drive my deploy with `browser_*`:
  - Close a conversation: the button pends, then the row leaves conversations-active.
  - Toggle a setting: it pends, then flips.
  - Edit notes: no per-keystroke lag.
  - Queue drag-reorder: the row holds where dropped and settles on the server rank, with no snap-back.
  - Type in a page: still optimistic.

## Outcome (implemented)

Done as planned, with these differences:

- **Callers were reverted, not rewritten.** Where a caller had changed only in d41803d0f3 / 715f1815ec, it went back to its code from before those two commits, which already used `useEndpointMutation` / `fetchEndpoint` helpers: the Close / Drop pending labels, `api.ts` helpers and the sonata `exempt/` entries are back. The rest (tasks `usePatchTask`, auto-start, deploy, config_v2, claude accounts, page tags, canvas picks, …) were moved mechanically to `useEndpointMutation`. `usePatchTask` now resolves when the server holds the edit, so Buttons pend on it. `useEndpointMutation`'s variables are no longer distributive, so a union body is one body.
- **More of network/live reverted.** `use-live.ts`, `use-pages.ts` and `use-live-reader.ts` are back to their code from before the two commits; nothing else had touched them. The overlay fixes made after them went too: 0fffcd922d, ad48b0e855, and a2ec2557bc (`OrderableKeys`, `orderScalar`). `entitySendLaneKey`, the multi-key lanes and the lane override are removed.
- **Routes facet / parse-utils / docgen** are back to their code from before 715f1815ec, so there is no `internal` label in the docs either. `internal` is still a type-level marker.
- **Queue:** `reorderQueue` answers nothing now; the `{ watermark }` ack is gone.
- **Known gap, not addressed:** a write that sends a whole value computed from the current read (page tags' `setTagIds`, config fields) can lose an edit if the user makes a second one before the first push lands. That window between the response and the push is what the future sync design closes. Most surfaces had this behaviour before the prediction work too.
