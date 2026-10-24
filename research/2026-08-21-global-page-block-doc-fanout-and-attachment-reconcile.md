> **Status (2026-08-23).** F5 (the attachment-reconcile batching) was implemented and verified.
> F3 + F4 (the hydration fixes) were implemented and unit-tested. **F1 was implemented and reverted**
> — declaring the point membership caused a reproducible cross-context delivery regression, and the
> resource-scoping problem is being redesigned from scratch under its own task. F2 and F6 were never
> started. For the branch's current state see
> [`2026-08-23-global-page-editor-cleanup.md`](./2026-08-23-global-page-editor-cleanup.md).

# Page editor: text vanishes while typing — fan-out, reconcile flood, and a destructive cure

## Context

Reported symptom: *"When I type in the page app, the content I'm writing suddenly disappears. I wait a few seconds and the content reappears."*

The investigation found three independent defects, all verified in code and corroborated by the running
instance's own telemetry. Two of them are caused *by typing*, which is why the symptom correlates with it.
None of them lose data — the text is safe on the server throughout — but together they make a page editor
unusable under load, and they degrade the whole cluster while anyone types.

Live evidence at time of writing (main instance, `query_db`):

| Signal | Value |
|---|---|
| churn monitor | `page-block-doc: ~47.8 no-op pushes/s (×2866/60s)` |
| `slow_ops` | `push deliver:page-block-doc` 22,053 slow, max 161 s |
| `slow_ops` | `sub:page-block-doc` 12,195 slow, max **907 s** |
| `slow_ops` | `page.attachment-block.reconcile` max **1,050 s** |
| `reports` | `queue-slot-hog`: reconcile held a slot 2 m 21 s |
| `reports` | 344 × "reclaimed page.attachment-block.reconcile — its worker died" |
| `reports` | `queue-backlog` 304 ready, oldest overdue 181 s |
| `reports` | `collab-hydration / starved-doc` count 572, incl. a ~68-in-4 s burst |

## What is actually broken

### D1 — `page-block-doc` fans out to every open block editor (confirmed)

`plugins/page/plugins/editor-collab/server/internal/resource.ts:20` declares `identityTable:
"page_block_docs"` but **no `membership`**. In `plugins/framework/plugins/resource-runtime/core/runtime.ts:4544`,
the id-intersection filter — the `continue` that skips tuples the change didn't touch — runs only when
`entry.membership?.kind === "point"`. Without it, every write to `page_block_docs` calls `scheduleNotify`
for **every subscribed `{blockId}` tuple app-wide**; each runs its own `WHERE block_id = ?` and diffs to
empty.

Typing flushes a `doc-update` every ~300 ms, so the fan-out is continuous while anyone types. This is the
47.8 no-op pushes/s, and it is the load that makes `sub:page-block-doc` reach 907 s.

The resource's own comment asserts the opposite ("only that block's subscribers recompute … and no push").
The *no push* half is true — an empty diff sends no value frame — and that is precisely what hid the cost:
**the refill is the cost**, not the frame.

`plugins/page/plugins/annotations/plugins/todo/plugins/task-link/server/internal/resource.ts` has the
identical defect. Its comment reasons carefully about whether a scoped refill would save work *per call*
and concludes it wouldn't — while never asking how many calls there are. That is the shape of the mistake.

### D2 — the starvation detector calls "slow" "broken", and its cure empties the editor (confirmed)

`plugins/page/plugins/editor/web/components/collab-text-plugin.tsx` `useHydrationGuard`: if a block's row
has text, its doc is empty, and nothing was typed here, it waits `STARVATION_SETTLE_MS = 5000` (line 52),
files a report, and calls `rehydrate()`.

With `sub:page-block-doc` reaching 907 s, a *healthy* cold open blows past 5 s routinely. So the detector
fires on blocks that were about to hydrate — and `rehydrate()` ends the session and mints a **fresh empty
replica**, so the rebuilt binding attaches to an empty doc. The text genuinely leaves the DOM; it is not
merely covered. Then the re-read has to complete before it returns.

Worse, it self-amplifies: a whole page's blocks rehydrating at once fires N doc-inits *into the load that
caused the timeout*. The 68-in-4 s burst is that amplifier.

### D3 — the attachment reconcile runs one transaction per block, per page, per second of typing (confirmed)

`plugins/page/plugins/attachment-block/server/internal/reconcile.ts` loops
`await blockAttachments.set(block.id, …)` sequentially over every block on the page, and
`plugins/infra/plugins/attachments/server/internal/define-link.ts:75` opens its **own `db.transaction` per
call** — including for the overwhelmingly common case of a block with no attachments, which still runs a
delete-nothing DELETE inside a transaction.

It is bound to `blocksChanged`, which fires on **every ~1 s `data.text` projection settle**
(`handle-patch-blocks.ts:213` → `notify.ts:19`). So one second of typing on a 200-block page schedules 200
sequential transactions. `hold: "instant"` is already correct and does not help; the job's own comment
already names both defects and they were never fixed.

### Open question — the exact path that blanks a block *mid-typing*

D1 + D2 fully explain a page **opening** into skeletons for seconds. They explain a mid-typing blank only
if a session restart happens under the cursor, which I could not prove from code or telemetry. The fixes
below are chosen so the symptom is impossible regardless of which path causes the session churn (F3 + F4
together), rather than betting on one story.

### Withdrawn — do not re-litigate these

- **The pane does not unmount on a transient resource error.** `StickyResolveGuard`
  (`plugins/primitives/plugins/pane/web/components/pane-resolve-guard.tsx:65`) latches `sawFound` and keeps
  rendering the body through a `pending` re-flip; regression-tested in
  `plugins/primitives/plugins/pane/web/__tests__/sticky-resolve-guard.test.tsx`. `useOptimisticResource`
  independently falls back to `result.stale`.
- **`resident` / `bootCritical` fix nothing here.** `resident` only sets `gcTime: Infinity`
  (`use-resource.ts:284`); `bootCritical` is separate and is param-less-global only, so `page-blocks`
  (keyed by `{pageId}`) can never be boot-critical and is a poor `resident` candidate.

---

## F1 — Declare the point membership

`plugins/page/plugins/editor-collab/server/internal/resource.ts`:

```ts
export const blockContentServerResource = defineResource(blockContentResource, {
  loader: ({ blockId }) => loadBlockDoc(db, blockId),
  identityTable: "page_block_docs",
  membership: { kind: "point", idsOf: ({ blockId }) => [blockId] },
});
```

`membership` and `identityTable` **coexist** — `createResource` (`runtime.ts:1884`) *requires* `mode:
"keyed"` and an `identityTable` whenever `membership` is present. `page_block_docs`' PK is `block_id`,
which is also the resource's `keyOf`, so `idsOf` returning `[blockId]` is exactly right.

Apply the same fix to `todo-task` (`…/todo/plugins/task-link/server/internal/resource.ts`, PK is
`parent_id` = the params `blockId`).

Rewrite the false paragraph in both module comments, and the matching claim in
`plugins/page/plugins/editor-collab/CLAUDE.md`.

**Risk is bounded.** The drain switches to `drainMembershipScoped`; our loader ignores `ctx.affectedIds`
and returns the same 0-or-1 row. Any loader throw falls back to `drainMembershipFull` — i.e. today's
behaviour. A DELETE now runs zero loader calls (resolved from the `deleted` set), strictly better. Do
**not** add `ackChannel`: these writes go through the collab provider's queue, not `optimistic-mutation`.

## F2 — Make a silent fan-out unspellable (structural rung)

Add a third arm to `KeyedMembership` and move `membership` into `ScopePolicy` so declaring `identityTable`
demands an answer:

```ts
| { kind: "fan-out"; reason: string }

export type ScopePolicy<P extends ResourceParams = ResourceParams> =
  | { identityTable: string; membership: KeyedMembership<P>; recompute?: never }
  | { recompute: { kind: "full"; reason: string }; identityTable?: never; membership?: never };
```

`kind: "fan-out"` normalizes to internal `membership: undefined`, so **runtime behaviour is byte-identical**
— this is a declaration requirement, not a behaviour change.

This is rung 2 (type error), and the precedent is one level up in the same type: `ScopePolicy` already
forces `identityTable` XOR `recompute: {kind:"full", reason}` so *"a FULL fallback is always a declared,
documented choice — never a silent default"* (`runtime.ts:262`). A fan-out is currently a silent default.
This is the same sentence, one level down.

A `fan-out` arm is required, not optional: three resources genuinely cannot express point/window membership
because their params key a *foreign* column, not the identity PK — `pushes-by-attempt`,
`block-prompt-tasks`, and `agent-notes-authors` (composite PK, so the feed can never pass affected ids).
Forcing them to lie would be worse than the status quo.

Rejected alternatives: deriving membership automatically is not possible (the runtime knows `keyOf` and a
table *name*, never a column name); a runtime assert sees closures, not columns; a check alone is rung 3
where rung 2 fits.

**Still add the check as a backstop** — `query-resource`'s compilers build opts with
`as ServerResourceOptions<…> & ScopePolicy` (`compile.ts:143`, `compile-window.ts:138,269`), so a cast
bypasses `tsc`. Extend the existing `keyed-resource-scope` check. Consequence: the two compilers will not
fail to compile and **must be edited by hand** (`compile.ts` emits `fan-out`; `compile-window.ts` already
emits real membership).

Survey: ~13 hand-written sites need a declaration; every `queryResource` / `windowQueryResource` site is
covered by editing the two compilers. Two of the thirteen are live bugs (`page-block-doc`, `todo-task`) —
which is the evidence the rung is at the right height.

## F3 — Make starvation recovery honest and non-destructive

Both halves are in `collab-text-plugin.tsx` `useHydrationGuard`.

**(a) Gate the starved arm on `provider.isSynced`.** The arm's real claim is "the push never arrived", and
the client already publishes that witness — `LiveStateYjsProvider.isSynced` (`live-state-yjs-provider.ts:546`,
flipped in `markSynced()` at line 817, with an existing `on("sync")` channel at line 349). `!isSynced` means
*no authoritative answer yet*; an empty doc then proves nothing. Only `isSynced && docLength === 0 &&
rowLength > 0 && !hasLocalEdits` is real starvation. This removes the entire false-positive class with no
invented estimator.

**(b) Stop re-attaching a healthy binding.** The non-destructive verb already exists:
`provider.rehydrateFromServer()` (`live-state-yjs-provider.ts:711`) re-reads authoritative state into the
live canonical doc without touching the replica or the session — nothing on screen changes. Expose it as
`CollabBlockDoc.refetch()` and route:

- `starved-doc` → `refetch()` (the doc is behind the server; the binding is fine)
- `blind-binding` → keep `rehydrate()` (a missed post-attach `observeDeep` set is the only defect a
  re-attach fixes)
- user-pressed `stalled` Retry → keep `rehydrate()`

A residual false positive then costs one idempotent seed instead of blanking a line.

**(c) Re-anchor the window.** Start the settle timer from the `isSynced` edge rather than from mount, and
drop it to ~2 s. The thing that was slow now starts the clock, which is the adaptive answer without an
estimator.

*Verify while implementing:* `rehydrateFromServer()` sets `synced = false`, pausing the outbound flush.
Bytes queue and drain, but confirm against `live-state-yjs-provider.test.ts` that a refetch mid-typing does
not strand the queue.

**Leave the report fingerprint alone.** Fingerprinting on `reason` is correct — one defect, one row, and
`count` says how often. The 572 is a false-positive rate, which (a) and (b) fix. Re-read it after
deploying; if it stays high the right addition is an `episodeId` from a burst collector, not `pageId`.

## F4 — Never paint a skeleton over text the user has already seen

Ships **with F3**, not instead of it: on its own it would trade a skeleton for a blank line, because
`rehydrate()` genuinely empties the editor.

State lives on `BlockDocOwner` (`collab-session.ts`) — the one thing that is "this block's content,
independent of any binding", so it survives both a session restart and a Lexical remount:

1. Add monotonic `everRendered: boolean`, set from `CollabSession.verifyRendered(shownLength)` whenever
   `shownLength > 0`. Never cleared — it states what the user *was shown*. Notify `stateListeners` on the
   false→true flip.
2. Fold it into the existing `useSyncExternalStore` snapshot in `use-collab-block-doc.ts` (a frozen
   `{ state, everRendered }` replaced only on a real transition, preserving identity stability). Expose as
   `CollabBlockDoc.everRendered`.
3. `hydration-placeholder.tsx` ladder becomes: `hydrated` → null; `stalled` → Retry chip; **`everRendered`
   → null**; `rowLength === 0` → null; otherwise skeleton.

`stalled` stays above the latch deliberately — it is right-aligned and covers nothing, and a partially
rendering binding still owes the user a way out.

## F5 — Batch the attachment reconcile

Add `setMany(entries: { ownerId: string; ids: readonly string[] }[])` to the `AttachmentLink` handle in
`plugins/infra/plugins/attachments/server/internal/define-link.ts`. The link table's PK is composite
(`primaryKey({ columns: [t.ownerId, t.attachmentId] })`), so the diff key is the pair. One transaction:

```ts
// key = `${ownerId} ${attachmentId}`
const owners = [...new Set(entries.map((e) => e.ownerId))];
if (owners.length === 0) return;
await db.transaction(async (tx) => {
  const existing = await tx
    .select({ ownerId: table.ownerId, attachmentId: table.attachmentId })
    .from(table)
    .where(inArray(table.ownerId, owners));            // ONE read over the touched owners
  const have = new Set(existing.map(keyOf));
  const toInsert = wantedRows.filter((r) => !have.has(keyOf(r)));
  const toDelete = existing.filter((r) => !wanted.has(keyOf(r)));
  if (toInsert.length > 0) await tx.insert(table).values(toInsert).onConflictDoNothing();
  if (toDelete.length > 0)
    await tx.delete(table).where(
      or(...toDelete.map((r) => and(eq(table.ownerId, r.ownerId), eq(table.attachmentId, r.attachmentId)))),
    );
});
```

`notInArray` is single-column and cannot express the pair, but it isn't needed: the stale set is computed
in memory and deleted by an `or` of composite equalities, which is small in practice. (`or` is not yet
imported in that file.)

**The property that matters is not batching, it is silence.** A text edit changes no attachment links at
all, so `toInsert` and `toDelete` are both empty and the reconcile performs **one cheap indexed SELECT and
no writes**. Today that same edit performs N transactions each doing a delete-nothing DELETE. Do *not*
implement this as delete-all-then-reinsert inside one transaction — it is simpler but rewrites unchanged
rows, which fires the change-feed on `page_blocks_attachments` for rows that did not change, recreating an
F1-shaped churn source.

Owners with an empty id set contribute nothing to the insert and are covered by the delete arm.

Make `set()` a one-entry `setMany()` so there is one implementation. The other three `.set(` callers
(`tasks/…/handle-update.ts:21`, `handle-create.ts:49`, `sonata/…/import.ts:106`) are single-owner and
unaffected.

`reconcilePageAttachments` keeps its in-memory collect loop exactly as-is — the generic
`AttachmentBlock.Collector` contract and its collection-consumer separation do not change — and accumulates
`{ownerId, ids}` pairs, writing once at the end.

Copy the shape from `plugins/page/plugins/links/server/internal/reindex.ts` `reindexPage`: one select,
in-memory set-diff across all blocks via a generic extractor registry, then at most one batched INSERT and
one batched DELETE.

Also read `page/inline-date`'s reminder reconcile for the same unbatched shape before closing this out.

## F6 (optional, lowest priority) — Discriminate `blocksChanged`

Feasible and backward-compatible: a new nullable filter column on `blocksChanged` stores `null` for every
existing `.where()`-less subscriber, and the plain-column matcher `OR(col IS NULL, eq(col, payload[key]))`
(`events/server/internal/event.ts:105`) keeps them match-any with zero code changes. Adding the column is a
normal additive migration via `./equin build` — no backfill.

But the win is bounded to **one** of five subscribers. Content-search, history, inline-date and links all
genuinely depend on block text (a page-history snapshot is a content snapshot, so it must record typing);
only attachment-block is text-independent. And the split is really `data.text`-only vs everything-else, not
structure vs data — an image's `attachmentId` change is a `data`-only change that must still reach
attachment-block — so it needs per-row `data`-key diffing against the already-loaded `stored` rows at
`handle-patch-blocks.ts:111`.

That reduces how *often* the reconcile runs; F5 fixes what makes each run expensive. Do F5 first and only
revisit this if the rate still matters.

---

## Order

1. **F1** — 4 lines, two files. Deploy and measure; it is the root cause of the latency F3 mistakes for
   corruption, so everything downstream gets easier to judge.
2. **F5** — kills the measured slot-hold and the worker deaths, independent of F1.
3. **F3 + F4 together** — this is what stops text from vanishing.
4. **F2** — largest churn, zero runtime risk, best done after F1 so its survey runs against already-correct
   resources.
5. **F6** — only if the rate still matters after F5.

## Verification

**F1** — the discriminating test is that two clients on the *same* block still both receive the push while
a *different* block's write reaches neither:

```bash
bun plugins/page/plugins/editor-collab/e2e/crdt-multitab-agent-verify.ts
bun plugins/page/plugins/editor-collab/e2e/crdt-adjacent-surfaces-verify.ts   # disjoint delivery
bun plugins/page/plugins/editor-collab/e2e/crdt-newblock-verify.ts            # doc-init FK gate
bun plugins/page/plugins/editor-collab/e2e/crdt-offline-verify.ts             # queue + reconnect
bun plugins/page/plugins/editor/e2e/crdt-reopen-verify.ts                     # cold hydration
bun plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts                # the DELETE/exit path
./equin test plugins/framework/plugins/resource-runtime                 # point routing
```

**F3 + F4** — `./equin test plugins/page/plugins/editor` (`collab-hydration-state.test.ts`,
`collab-session.test.ts`, `live-state-yjs-provider.test.ts`). No e2e forces a rehydrate today; add
`plugins/page/plugins/editor/e2e/hydration-recovery-verify.ts` asserting (i) rendered text never goes empty
across a `refetch`, (ii) no skeleton ever paints over a block that already showed text.

**F5** — `./equin test plugins/infra/plugins/attachments`; add a `setMany` unit case covering the
empty-ids owner and the mixed batch.

**F2** — `./equin check keyed-resource-scope` (extended) and `./equin check type-check`.

**Measuring the drop.** Baseline first, `./equin build`, then re-read after a comparable typing
session:

```sql
-- the churn report should disappear; collab-hydration's count should stop advancing
select kind, count, last_seen_at from reports
where kind in ('live-state-noop','collab-hydration','queue-slot-hog','queue-backlog')
order by last_seen_at desc;

-- the two numbers that must collapse
select operation, count, max_ms from slow_ops where operation like '%page-block-doc%';

-- the reconcile's slot-hold
select operation, count, max_ms from slow_ops where operation like '%attachment-block%';
```

`sub:page-block-doc` is the number that proves the user-visible fix — it is what the starvation window was
racing.

> `./equin build` is ~10 min median: run it with `run_in_background: true` and end the turn.
