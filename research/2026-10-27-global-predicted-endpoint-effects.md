# Predicted endpoint effects — optimistic by declaration

## Context

Clicking **Close** or **Drop & Close** at the bottom of a conversation shows a spinner
until the server has stopped the agent, deleted its session and answered
(`push-and-exit-button.tsx:362-381` awaits `fetchEndpoint(exitConversation | dropAndExit)`).
The user wants these optimistic, and asked for a *generic* mechanism that:

1. makes a write show its effect at once, on **every** surface that reads the changed
   data (header, sidebar, the button itself, the exit menu);
2. is **forced** — a new surface cannot accidentally be pessimistic;
3. still tells the user when the server has confirmed — and **files a report** when
   confirmation is slow or never comes.

An audit of all 256 write endpoints (`/tmp/audit-{apps,conv,infra,rest}.md`, summary below)
showed the first sketch was wrong in four places: a fixed-row-patch vocabulary is too weak,
"no promise" breaks real flows, never-revert is wrong where a precondition can fail, and a
new report kind would duplicate the existing `confirm` latency signal. This plan is the
revised design. Close / Drop & Close (and the sidebar's `closeConversation`) are its first
consumers.

### Audit summary (256 write endpoints)

| A clean fit | B fit with caveat | C should stay unpredicted | D not user-facing |
|---|---|---|---|
| 45 | 79 | 89 | 43 |

Realistic reach: 60–100 endpoints. Recurring needs: upsert onto a maybe-absent row,
increments/server timestamps, request-conditional effects, whole-list reducers (ranks),
liveValue targets (config, curriculum, picks), ordered non-commuting ops. Recurring
blockers: server-minted ids the caller navigates to, response-driven follow-ups,
server-checked preconditions (409/400), server-derived fields (task status rollup).

## Findings this design rests on

- **There is no normalized row store.** Each live tuple (`[key, params]`) is its own
  TanStack entry holding a row array (`live-state/web/notifications-client.ts:354`);
  `useLiveRow` reads its own `:rows` point tuple (`network/live/web/internal/use-live.ts:1148`);
  windows are read through `usePages` (`use-pages.ts:484`). A row leaving one window and
  entering another arrives as two uncorrelated frames.
- **Row identity already exists:** every collection declares `from: <entityRef>`
  (`infra/entities/core/internal/entity-ref.ts:24`). `conversations-active`, `-gone`,
  `-system` and `conversations.by-id` all use `conversationsEntityRef`
  (`tasks-core/core/resources.ts:298-378`).
- **Membership is server-only.** `conversations-active`'s predicate is a drizzle `where`
  in `tasks-core/server/internal/conversation-rows.ts:52-58`. The client already has an
  in-memory evaluator (`network/live/plugins/filter`'s `matchesFilter`) and the server a
  renderer (`filterSql`) for the same `Filter` data.
- **Entering a window cannot be predicted safely:** window rows carry a server-minted
  `$key` (`row-key.ts:15`) and counts are separate server-recounted values.
- **Reusable pure machinery** in `primitives/optimistic-mutation/web/internal/`:
  `overlay.ts` (`replay`, `confirmPass`, `ackPass`, `PendingOp`), `send-lane.ts`
  (module-level ordered lanes), `web/reporter.ts` sinks. But `optimistic-mutation`
  imports `network/live`, so `network/live` cannot import it back.
- **`network/live` already imports `infra/endpoints`**, so `endpoints` must not import `live`.
- **Latency plumbing exists:** `latency-signal`'s `confirm` signal (phases `send-lane`,
  `retry`, `server-ack`, `confirm-frame`) → `clientLatencySink` → `debug/slow-ops`
  (`latency-slow-op.ts`, threshold `confirmMs` = 2000) → `recordReport({kind:"slow-op"})`.
  Gap: a sample is emitted only *at* confirmation, so a write that never confirms emits
  nothing — exactly the frozen-push case (`9fef500510`). The divergence "stalled" report
  counts pushes, so it also stays silent when no push arrives.
- `Button` auto-pends only on a returned promise (`ui-kit/web/components/ui/button.tsx:188-206`);
  `DropdownMenuItem` never does. `ExitItem` / `DropAndExitEntry` hand-roll
  "Closing…"/"Dropping…" from `isPending`; `EndThreadButton` shows `loading={close.isPending}`
  and calls `onEnded` only on success.
- `markConversationClosed` writes `{status:"done", endedAt: now, workingOn: null}`
  (`tasks-core/server/internal/mutations/conversations.ts:311`); the task's status is a
  server rollup (`rollup-spec.ts`); `dropTaskOnExit`'s `dropped` is decided server-side.
- `closeConversation` (`conversations/core/endpoints.ts:166`, used by
  `conversation-list.tsx:~26`) is a near-duplicate of `exitConversation`.

## Design

### 1. The effect is a pure function declared on the endpoint (core)

```ts
// conversation-view/exit/core/endpoints.ts
export const exitConversation = defineEndpoint({
  route: "POST /api/conversations/:id/exit",
  needsMachine: { feature: "Closing an agent's conversation" },
  effect: patchRow(conversationsEntityRef, ({ params }) => params.id, () => ({
    set: { status: "done", workingOn: null },
    approx: { endedAt: new Date() },        // shown, never compared
  })),
});
```

- **`effect` is an opaque `EndpointEffect<TParams, TBody>`** declared in
  `infra/endpoints/core` (a branded interface, so `endpoints` stays below `live`). The
  builders live in **`network/live/core`** (`predict.ts`):
  - `patchRow(entity, idOf, patchOf)`: `set` fields are predicted *and* used for
    confirmation; `approx` fields are shown but not compared (client clock).
  - `removeRow(entity, idOf)`.
  - `effects(...list)` for several targets.
  - `applyRows(entity, idsOf, (rows, req) => rows)`: the free-form reducer (upsert,
    increment, conditional, ranks) for the next consumers. It is in the vocabulary from
    day one but only `patchRow` is used in this plan.
- **The target is an entity, not a collection.** The overlay is keyed by
  `(entityRef.name, rowId)`, so every collection whose `from` is that entity sees the
  prediction, including collections added later, with no edit to the effect.
- **Effects only predict what the request decides.** `dropAndExit` predicts the
  conversation half only; the task's `dropped` / derived status arrive by push.
- **Out of scope for effects:** inserts with a server-minted id the caller needs,
  response-driven flows, server-checked preconditions. Those endpoints keep
  `useEndpointMutation` unchanged.

### 2. One shared overlay per (entity, row), applied inside the live reads

New `network/live/web/internal/predict-overlay.ts`: a **transport-scoped** store
(`transportScoped`, so a demo scope has its own), subscribed with `useSyncExternalStore`.

- **Read side.** Two hook-in points, both inside `network/live`:
  - `useLiveRow` (`use-live.ts:~1160`): patched row.
  - `usePages` (`rowsOfResult`, `use-pages.ts:~796`) and `useLive(all)`: each row
    patched, then **membership re-checked**. A collection that declares its base
    `membership` (below) drops a patched row that no longer matches it, using
    `matchesFilter`. The window's own decoded `where` (`window.decode`) is checked the same
    way. **Entering** a window is never predicted (no `$key`, no count); the server's frame
    brings it.
- **Membership becomes data.** `liveCollection` gains `membership?: Filter` (core).
  `serveCollection` renders it with `filterSql` instead of a hand-written drizzle `where`,
  so client and server read one declaration. First adopters: `conversations-active` and
  `conversations-system`. A collection without `membership` still gets patched rows in
  place; it just cannot predict an exit.
- **Retirement is per tuple** (reusing `overlay.ts`'s rules). An op stops applying to a
  tuple once that tuple's server data agrees with the `set` fields (row present with those
  values, or absent where the patched row fails membership), or its ack watermark is past
  the op's (Rule A, when the handler returns `currentTxId(tx)`). The op is done when no
  mounted tuple holding the row still needs it. This prevents the "by-id confirmed, active
  list still stale, row flickers back" race.
- **Pending is visible.** `useLiveRow` gains `pending: boolean` on the ready arm, and the
  hook reports to `sync-status` (`useReportSync`). The cloud keeps its exact meaning
  (syncing = not acked).
- **Ordering.** `send-lane.ts` and the reporter sinks (`optimisticRejectionSink`,
  `optimisticDivergenceReportSink`) move from `optimistic-mutation/web` to
  `network/live/web`; `optimistic-mutation` imports them from there. Both systems then
  share one lane per tuple. An effect's lane key is its first target `(entity, id)`.

### 3. The forcing: a predicted endpoint has exactly one, spinner-less client (tsc)

The same pattern as `needsMachine`'s `EndpointDef` / `MachineEndpointDef` split:

- `EndpointDef` / `MachineEndpointDef` gain `effect?: undefined`; a definition with an
  `effect` is a `PredictedEndpointDef`.
- **`useEndpointMutation` and `FetchEndpoint` refuse a `PredictedEndpointDef`**
  (an overload `effect?: undefined`): awaiting one, or raw-fetching it, is a tsc error.
- **`useLiveMutation(endpoint, { onSuccess?, onError? })`** in `network/live/web` is the
  only client. It returns `{ kind: "available", mutate(req): void } | { kind: "unavailable", message }`.
  - There is no `isPending` and no promise, so a spinner or a "Closing…" label cannot be
    written, and `Button`'s auto-pend never triggers.
  - `onSuccess(response)` stays, for response-dependent follow-ups such as the
    `dropped`-keyed toast.
- **`mutate` runs these steps:** apply the effect to the overlay; enqueue the send on the
  lane, through `endpointContractOf(endpoint)` (an endpoints-core export that strips
  `effect`; a lint allows it only inside `network/live`, an `exempt` "sanctioned" entry);
  arm the deadline (§4).
- **Failure follows never-revert, as today.**
  - Network failure: the prediction stays, the cloud shows error with Retry.
  - Permanent 4xx: the op leaves the overlay and is emitted on `optimisticRejectionSink`
    (a toast and a report, which already exist).
  - That is why server-checked preconditions are out of scope for effects (§1).
- **Requiring a decision on every write endpoint** (`effect` or `unpredicted({reason})` /
  `internal()`) is **phase 2, not this plan**. It is a tsc-required field, with the
  existing writes codemodded to `unpredicted` debt entries (`./equin exempt list --debt`).
  It waits until the vocabulary has proven itself on a few more consumers.

### 4. Unconfirmed deadline → the existing `confirm` signal → slow-ops report

- **On retirement:** emit the normal `confirm` sample, the same phases
  `optimistic-mutation` emits (`use-optimistic-resource.ts:92-120`), with variant
  `predict/<endpoint route>`. A slow confirmation then becomes a slow-op report through
  the existing `debug/slow-ops` path, with no new code there.
- **The deadline:** one one-shot timer per op, armed at dispatch and cleared at retirement
  or rejection. It is a deadline, not a poll, like `wedge-watchdog.tsx:134`.
  `UNCONFIRMED_MS = 10_000`, overridable per effect (`confirmWithinMs`). On expiry it
  emits a **censored** `confirm` sample: `censored: true`, the phases reached so far,
  `totalMs` = elapsed. `ClientLatencySample` gains `censored?: true`; `latency-slow-op.ts`
  passes it through as `detail.censored`.
- **The report says which part stalled.** The censored sample carries
  `server-ack` = missing (never acked) or `confirm-frame` = missing (acked, never
  reflected), plus the ack watermark when there is one.
- **Same gap in the existing primitive:** `useOptimisticResource` gets the same deadline
  (one shared helper), closing its version of the gap.

### 5. First consumers

| Site | Today | After |
|---|---|---|
| `exitConversation` (`exit/core/endpoints.ts`) | no effect | `patchRow(conversationsEntityRef, id, {status:"done", workingOn:null}, approx endedAt)` |
| `dropAndExit` (`drop-and-exit/core/endpoints.ts`) | no effect | same effect (the conversation half only) |
| `closeConversation` (`conversations/core/endpoints.ts:166`) | no effect | same effect; merging it with `exitConversation` is a follow-up |
| `push-and-exit-button.tsx` Close / Drop specs | `await fetchEndpoint`, `busy` spinner | `useLiveMutation(...).mutate`, synchronous `run`; the button flips to **Restore** at once, because `deriveExitMode` reads the patched row |
| `ExitItem` (`exit/web/components/exit-button.tsx`) | "Closing…" from `isPending` | `useLiveMutation`; the label and `isPending` disable go |
| `DropAndExitEntry` (`drop-and-exit-button.tsx`) | "Dropping…" / "Completing…" | `useLiveMutation`; `onSuccess` keeps the `dropped` toast |
| `EndThreadButton` (`agent-thread/.../end-thread-button.tsx`) | `loading={close.isPending}`, `onEnded` on success | `mutate` then `onEnded()` at once |
| `conversation-list.tsx` | `await fetchEndpoint(closeConversation)`, no error handling | `useLiveMutation(closeConversation)` |
| `conversations-active` / `-system` (`tasks-core/core/resources.ts`) | drizzle `where` on the server | `membership: Filter` in core; the server renders it with `filterSql` |

Not predicted: the task's derived status and its `dropped` flag, the gone list's entry and
count. They arrive by push. The success toasts become redundant; keep the
developer-audience Close toast, keep the `dropped` one.

## Critical files

- `plugins/infra/plugins/endpoints/core/define-endpoint.ts`: the `effect` option,
  `EndpointEffect`, `PredictedEndpointDef`, `endpointContractOf`.
- `plugins/infra/plugins/endpoints/web/internal/use-endpoint-mutation.ts`,
  `fetch-endpoint.ts`: refuse predicted definitions (overloads).
- `plugins/network/plugins/live/core/internal/predict.ts` (new): the builders.
- `plugins/network/plugins/live/core/internal/live-collection.ts`: `membership`.
- `plugins/network/plugins/live/server/…serve-collection`: render `membership` via `filterSql`.
- `plugins/network/plugins/live/web/internal/predict-overlay.ts` (new): store, retirement, deadline.
- `plugins/network/plugins/live/web/internal/use-live-mutation.ts` (new).
- `plugins/network/plugins/live/web/internal/use-live.ts`, `use-pages.ts`: apply the overlay.
- `send-lane.ts`, `reporter.ts`: moved from `optimistic-mutation/web` to `network/live/web`.
- `plugins/primitives/plugins/perfs/plugins/latency-signal/core/internal/signals.ts`: `censored`.
- `plugins/debug/plugins/slow-ops/web/internal/latency-slow-op.ts`: pass `censored` through.
- The consumers in §5.
- Docs: `network/live/CLAUDE.md` (a "Predicted writes" section),
  `infra/endpoints/CLAUDE.md` (`effect`), `optimistic-mutation/CLAUDE.md` (shared lane, deadline).

## Steps

1. Move `send-lane` and the reporter sinks into `network/live/web`; re-point
   `optimistic-mutation` and the `reports/*` collectors. This is a pure refactor and its
   tests must stay green.
2. `latency-signal` `censored`; deadline helper; adopt it in `useOptimisticResource`.
3. Endpoints: the `effect` type, `PredictedEndpointDef`, the overloads, `endpointContractOf`
   plus its lint and exempt entry.
4. Live core: `predict.ts` builders, `membership` on `liveCollection`, `filterSql`
   rendering in `serveCollection`.
5. Live web: `predict-overlay` (apply, membership exit, per-tuple retirement, rejection,
   deadline, sync-status), read-side application, `useLiveMutation`, `pending` on
   `useLiveRow`.
6. Conversations: `membership` on active/system; effects on the three endpoints; migrate
   the five call sites.
7. Docs; `./equin build`.

## Verification

- **Unit (`./equin test plugins/network/plugins/live`).**
  - The overlay patches a row in by-id, window and `all` reads.
  - A row failing `membership` leaves the window.
  - Per-tuple retirement: by-id retires before active, and the row never reappears in
    active.
  - A permanent 4xx removes the op and emits a rejection; a network error keeps it.
  - The deadline emits a censored `confirm` sample with fake timers, and a timely
    confirmation emits a normal one.
- **Type tests.** `useEndpointMutation(exitConversation)` and
  `fetchEndpoint(exitConversation, …)` fail tsc; `useLiveMutation` returns no
  `isPending` / promise.
- **Component (`./equin test plugins/conversations/plugins/conversation-view`).**
  - Clicking Close renders Restore before the fake endpoint resolves.
  - Drop & Close shows the `dropped` toast on resolve.
  - `EndThreadButton` calls `onEnded` synchronously.
- **`./equin test plugins/primitives/plugins/optimistic-mutation`:** green after the move.
- **End to end on this worktree's build.** Drive the conversation view with `browser_*`
  and click Close on a throwaway conversation. The button shows Restore and the sidebar
  row leaves Active with no spinner; the gone list fills on the push. Check Debug →
  Slow ops: no unconfirmed sample under normal conditions. Kill the backend between
  click and confirm: a censored `confirm` slow-op report appears after 10 s.
- `./equin check` (boundaries: no `endpoints → live` edge; `plugins-doc-in-sync`).
