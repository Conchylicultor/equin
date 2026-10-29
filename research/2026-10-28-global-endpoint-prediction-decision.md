# Every write endpoint decides its prediction

Phase 2 of `research/2026-10-27-global-predicted-endpoint-effects.md` (§3, last bullet).

## Context

Predicted writes landed: a write endpoint may declare `effect: (on) => patchRow | removeRow |
applyRows | effects(...)`, and such a definition (`PredictedEndpointDef`) has exactly one
browser client, `network/live`'s `useLiveMutation`, which has no pending state. Only
`exitConversation`, `dropAndExit` and `closeConversation` opted in.

It is still opt-in. A new write is declared with no effect by default, its surfaces go on
awaiting it behind a spinner, and nobody decided that. The goal: **a write endpoint cannot be
declared without saying how its effect reaches the user** (predicted, unpredicted for a
stated reason, or not called by the browser). Every endpoint that should be predicted but is
not yet must be visible debt, named by the reason it is blocked.

The audit of the 256 write endpoints (`/tmp/audit-{apps,conv,infra,rest}.md`: 45 clean fits,
79 fits with a caveat, 89 stay unpredicted, 43 not user-facing) gives the per-endpoint
answers. It also lists nine gaps, and for each one the vocabulary must either **cover** it or
**refuse** it with a named reason. §3 decides each one.

## Design

### 1. The decision is one required arm of `defineEndpoint`'s write options (tsc)

A write route's options take **exactly one** of:

```ts
effect: (on) => patchRow(on, …)                     // predicted → useLiveMutation only (exists)
unpredicted: { reason: "precondition", why: "409 when nothing to align to; shown inline" }
unpredicted: { gap: "upsert" }                      // should be predicted; blocked (debt, §2)
internal: { why: "server → central RPC; a POST so the secret name stays out of URLs" }
```

- **The arms are one discriminated options union**: each arm types the other keys `?: never`.
  So declaring none or two is a tsc error, and the decision has one spelling. A GET still
  takes none of them, because they are typed `never` on a read, as `effect` is today.
- **`agentWrite: "telemetry"` is the decision, derived.** A telemetry write (logs, latency
  samples, reports) is the fourth arm, and it takes none of the three keys. It is not
  declared twice.
- **`unpredicted.reason` is a closed union, `UnpredictedReason`**, taken from the audit's C
  bucket and from the refused gaps (§3). `why` is required and non-empty, checked at
  declaration the way `access.public` is (`resolveAccess`).
  - `"server-minted-id"`: the caller needs an id the server mints, to navigate to it or select
    it.
  - `"response"`: the surface renders the answer (a result union, a tally, a resolved status).
  - `"precondition"`: a server-checked 409 or 400 that the surface shows inline.
  - `"server-decided"`: the request does not decide the outcome; an LLM, an external API, a
    job, the filesystem or git does. The pending state is the honest UX.
  - `"unobserved"` (added during the migration): bookkeeping no surface renders back (a
    viewed-at stamp, a GC hold, an upload the caller already holds).
- **`internal` means "no browser client", and the types hold it to that.** It produces an
  `InternalEndpointDef` (with `internal: { why }`). `EndpointDef` and `MachineEndpointDef`
  gain `internal?: undefined`, so `FetchEndpoint`, `useEndpointMutation`, `readNdjson` and
  `useLiveMutation` all refuse it (the same overload trick as `effect?: undefined`).
  `callEndpoint`, `implement` / `implementMachine`, central handlers and e2e flows take
  `AnyEndpointDef`, which now includes it.
- **The runtime backstop:** `defineEndpoint` throws on a write that a cast got past tsc with
  no arm, or with two arms, or with an empty `why`.
- **Visible per plugin.** The `routes` facet (`plugin-meta/facets/plugins/routes`) records
  each route's decision (`predicted | unpredicted:<reason> | debt:<gap> | internal |
  telemetry`). Each plugin's `CLAUDE.md` autogen shows it, and `docs/plugins-details.md`
  gains a debt-per-gap index. `plugins-doc-in-sync` keeps both current.

### 2. Debt is a gap, and a gap is a union member with one task

`unpredicted: { gap: PredictionGap }` is the debt arm. `PREDICTION_GAPS` in
`infra/endpoints/core` is a data table, `gap → { task, what }`, with one task per gap (filed
when this lands). The endpoint does not repeat the task.

- **Closing a gap means deleting its member.** That turns every endpoint still declaring the
  gap into a tsc error, so the compiler lists the migration. There is no allowlist to keep in
  sync and nothing to forget.
- **The gaps are the cover-verdicts of §3, plus `"call-sites"`.** `"call-sites"` is for an
  effect that the existing builders express already but whose callers still await the write
  or hand-roll a pending label (most of the audit's clean fits). It stays debt until those
  callers move to `useLiveMutation`.
- Debt is listed by the facet index, not by `./equin exempt list --debt`. Exempt manifests
  are scoped per file and per rule, and this debt is per endpoint and already typed.

### 3. The nine audit gaps: covered or refused

| Gap | Verdict | How |
|---|---|---|
| Upsert onto a maybe-absent row (transpose, key-mode, swing, rhythm, chord-mode, prototype state, starred) | **cover**: gap `upsert` | `upsertRow(on, entity, idOf, (row \| undefined, req) => row, { set? })`. A by-id holder turns `absent` into `found`, and an `all` tuple that declares `membership` gains the row when it matches. Windows: entering is still never predicted (no `$key`, no count). |
| Increments, server timestamps (recordPlay, rounds, history) | **cover**: gap `increment` | Today a `rows` target retires **at ack**, so a frame that arrives after the ack makes the +1 vanish and come back. Fix: the ack carries the commit watermark, and a tuple confirms an uncompared target only once its own frame's watermark is at or past it. This is Rule A of `optimistic-mutation`'s `overlay.ts` (`ackPass`). Server timestamps stay `approx`. |
| Request-conditional effects (swing: `score` removes the row, others upsert it) | **cover**: gap `conditional` | `choose(on, (req) => key, { [key]: effect })`. Each branch is built on the same `on`, so the definition still resolves its effect once. |
| Whole-list reducers (ranks: tag tree, reorder) | **cover**: gap `ranks` | An `applyRows` over the siblings rewrites their rank fields. A read whose `orderBy` reads a patched field re-sorts **the rows it holds** with `core/key-order`. A row leaving its key-range page leaves; the server's frame brings it where it lands. |
| liveValue targets (curriculum, prototype picks, config) | **cover**: gap `live-value` | `patchValue(on, valueRef, paramsOf, (value, req) => value)`, keyed by `(value key, canonical params)` in the same overlay. It confirms by watermark (as `increment` does). `setPrototypePicks` moves off `useOptimisticResource` onto it. A config write rides the same arm unless `config_v2` already predicts it (verified in step 6). |
| Multi-tuple ordering lanes (track-view fader drag; chord-mode, then setTracksActive) | **cover**: gap `lanes` | An op enters the lane of **every** target `(entity, id)` (keys locked in sorted order, so two ops cannot deadlock). The effect may override with `lane: (req) => key` when the order is per parent (a song), not per row. |
| Predicate-wide writes (reset a song's track views, dismiss all notifications) — found during the migration | **cover**: gap `where` | `patchWhere` / `removeWhere(on, entity, (req) => Filter, …)` over every held row matching the filter (`matchesFilter`), confirmed by watermark. |
| Machine-gated endpoints | **already covered** | `PredictedMachineEndpointDef` plus `useLiveMutation`'s `unavailable` arm. A type test pins it, and there is no gap member. |
| Surfaces that need the response | **refuse**: `server-minted-id` / `response` | A response-driven *side effect* (a toast) is not this: `onSuccess` already covers it. Only rendering the answer, or navigating to it, is refused. The way out for minted ids is client-minted ids (`defineIdKind`'s portable `mint`), a later move per endpoint. |
| Precondition-checked writes (409 / 400) | **refuse**: `precondition` | Never-revert plus a rejection toast is wrong for an inline field error. |

### 4. The side findings

- **Reads sent as POST.**
  - `secretsGet` / `Has` / `Meta` / `List` are server → central RPCs. They become
    `internal`, which is honest: no browser client, and the POST keeps secret names out of
    URLs.
  - `findLoops`, `nextChords`, `countLoopsInSet`: each one with a browser caller becomes a
    typed-query `liveValue` read with `useLive` / `useLiveReader`. One whose only callers are
    e2e or server code becomes `internal`.
  - None of them may declare `unpredicted` (they write nothing).
- **Raw `void fetchEndpoint` writes** (transpose, swing, key-mode, recordPlay) are first
  declared as debt (`upsert` / `conditional` / `increment`). When their gap closes they gain
  an effect, and `FetchEndpoint` refusing a predicted definition makes the raw call a tsc
  error. The forcing moves them to `useLiveMutation`, with nothing extra to enforce.

## Steps

1. **Endpoints core:**
   - the options union (`effect | unpredicted | internal | telemetry`);
   - `UnpredictedReason`, `PredictionGap`, `PREDICTION_GAPS`;
   - `InternalEndpointDef`, plus `internal?: undefined` on the browser clients' overloads;
   - the runtime backstop.

   Type tests sit beside `web/internal/predicted-types.test.ts`.
2. **Codemod plus a hand pass** over every write definition (~256; `rg 'route: "(POST|PUT|PATCH|DELETE) '`).
   - Each one's arm comes from its audit row: C becomes `unpredicted` with a reason and
     `why`, D becomes `internal` (or nothing more when it is telemetry), and A or B becomes
     `{ gap }`.
   - Where the audit file is stale or missing a row, decide by hand: read the callers.
   - File one task per gap with `add_task` (track main, start after).
3. **Side findings:** move the secrets RPCs to `internal`, and the chord loop reads to live
   reads or `internal`.
4. **The `routes` facet** records the decision and renders it in the per-plugin autogen and
   the details index (debt per gap).
5. **Close `call-sites`:** migrate the clean fits' callers to `useLiveMutation`. Use the
   `patchRow` / `removeRow` already available, and drop the hand-rolled "…ing" labels and
   the awaited `mutateAsync` → `onClose` sequencing.
6. **Close the covered gaps, one step each**, in this order: `upsert` → `conditional` →
   `increment` (watermark ack) → `live-value` → `lanes` → `ranks` → `where`. Each step:
   - adds the builder and its overlay support, with unit tests;
   - deletes the gap member;
   - migrates the endpoints tsc now lists, and their callers.
7. **Docs:**
   - `infra/endpoints/CLAUDE.md`: the decision, the reasons, the gaps;
   - `network/live/CLAUDE.md`: the new builders;
   - the debt index.

Steps 1–4 make the decision required; that is the issue's fix. Steps 5–6 burn down the debt
they reveal, and each can land on its own.

## Critical files

- `plugins/infra/plugins/endpoints/core/define-endpoint.ts`: the options union, the def
  types, the backstop.
- `plugins/infra/plugins/endpoints/core/` (new `prediction.ts`): `UnpredictedReason`,
  `PredictionGap`, `PREDICTION_GAPS`.
- `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts`,
  `use-endpoint-mutation.ts`: refuse `internal`.
- `plugins/network/plugins/live/web/internal/use-live-mutation.ts`: refuse `internal`;
  multi-key lanes.
- `plugins/network/plugins/live/core/internal/predict.ts`: `upsertRow`, `choose`,
  `patchValue`, the `lane` option.
- `plugins/network/plugins/live/web/internal/predict-overlay.ts`: absent-row synthesis,
  watermark confirmation, re-sort, value targets.
- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts`: Rule A, reused
  for watermark confirmation.
- `plugins/plugin-meta/plugins/facets/plugins/routes/`: the decision in the facet.
- Every `core/endpoints.ts` that declares a write. Representative files:
  - `apps/plugins/chord/plugins/song-index/core/endpoints.ts`
  - `infra/plugins/secrets/core/…`
  - `tasks/core/…`
  - `apps/plugins/sonata/plugins/*/core/endpoints.ts`

## Verification

- **Type tests (`./equin test plugins/infra/plugins/endpoints`).** Each of these is a tsc
  error:
  - a write with no arm, or with two arms;
  - an `unpredicted` with no `why`;
  - `fetchEndpoint`, `useEndpointMutation` or `useLiveMutation` on an `internal` def;
  - a gap missing from `PredictionGap`.

  A `telemetry` write needs no arm.
- **Runtime:** `defineEndpoint` throws on a cast that gets past tsc (no arm, two arms, empty
  `why`).
- **`./equin check`:**
  - `type-check` is green over the whole repo with every write declared;
  - `plugins-doc-in-sync` shows the decisions;
  - boundaries add no `endpoints → live` edge.
- **Per gap step:**
  - `./equin test plugins/network/plugins/live` (the overlay: an upsert onto an absent
    by-id row, the increment staying through an ack that arrives before its frame, the
    conditional branch, a value target, a multi-key lane keeping the order, a re-sort within
    a page);
  - the migrated consumers' component tests;
  - on this worktree's build, one migrated surface per gap driven with `browser_*` (for
    example sonata's transpose changes the pitch display at once with no spinner, and Debug →
    Slow ops shows no unconfirmed sample).
