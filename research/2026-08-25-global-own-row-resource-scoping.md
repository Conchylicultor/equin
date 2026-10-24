# Own-row resource scoping: narrow *who* is woken, never *what* they receive

Date: 2026-08-25
Category: global (resource-runtime + page editor)

## Context

`page-block-doc` (`plugins/page/plugins/editor-collab/server/internal/resource.ts`) is a keyed
live-state resource whose params are `{ blockId }` and whose value is a 0-or-1-element array
holding that block's CRDT doc row. It declares `identityTable: "page_block_docs"` and nothing
else.

`identityTable` says *which resource* a change belongs to. It does not say *which params tuple*.
So `applyDbChange` fans a write on that table out to **every subscribed `{blockId}` tuple in the
app**: each one re-runs its own `where block_id = ?`, finds the changed row is not its own, and
diffs to empty. No frame is sent — which is exactly why the cost stayed invisible — but every
tuple paid for a database round trip. Typing flushes a `doc-update` roughly every 300 ms, so one
person typing costs one read per open block editor per flush, continuously.

Measured on the running instance (main DB):

- `live-state-noop` report: `page-block-doc: ~2.6 no-op pushes/s (×154/60s)`, last seen
  2026-08-23; an earlier peak of ~47.8/s is recorded in
  `research/2026-08-21-global-page-block-doc-fanout-and-attachment-reconcile.md`.
- `slow_ops`: `deliver:page-block-doc` ×27 950 (max 161 s), `sub:page-block-doc` ×14 889
  (max 907 s).

`plugins/page/plugins/annotations/plugins/todo/plugins/task-link/server/internal/resource.ts` has
the same shape (`page_blocks_ext_todo_task`, whose synthesized `parent_id` PK *is* the `blockId`).

### The previous attempt, and what a fresh reading of it says

Declaring `membership: { kind: "point", idsOf: ({ blockId }) => [blockId] }` on both resources was
tried (`research/2026-08-21-…` F1), compiled, passed unit tests, and was reverted
(`research/2026-08-23-global-page-editor-cleanup.md`) after "a reproducible cross-context delivery
regression": a second browser context opening a page a first context already had open rendered
the block's text as empty. The mechanism was never identified.

Two findings reframe that.

**1. The symptom description matches a check that already fails on `main`.**
`plugins/page/plugins/editor-collab/e2e/crdt-offline-verify.ts:132` is literally
`r.ok("second context converges", …)`, preceded by a fixed `waitForTimeout(5000)` at `:127` after
`pageB.goto`. The 2026-08-23 cleanup doc records that this exact check fails **identically on
main**, and separately warns that `crdt-typing` and `crdt-newblock` fail the same way under load
for the same fixed-wait reason ("re-run it alone before treating it as real"). Meanwhile the
runtime-level point test kept from that branch
(`runtime-window-membership.test.ts:765–820` — "a write to one id never reaches another id's
subscriber, even when the loader ignores ctx") is *exactly* the page-block-doc shape and passes.
The most parsimonious reading is that a pre-existing, load-sensitive, already-baselined failure
was attributed to F1. That would explain why no mechanism was ever found. It is a hypothesis, and
Step 1 below is what settles it.

**2. F1 was nonetheless not a routing-only change, and that is the real lesson.** Declaring
`membership` does three things beyond filtering ids:

- **It converts INSERT and DELETE from FULL to an incremental membership diff.** In
  `applyDbChange` (`runtime.ts:4522`), a membership entry turns `op:"I"` into `affected = ids` and
  `op:"D"` into `affected = {}` + `deleted = ids`. Without membership both are `affected = null`
  ⇒ FULL. So F1 silently rerouted every `doc-init` INSERT and every block-merge DELETE — i.e.
  exactly the split / merge / new-block paths the CRDT e2e suite covers — onto
  `drainMembershipScoped`.
- **It reroutes the drain** (`drainEntry`, `:3211`), and the two paths ship different frames. The
  legacy scoped keyed path sends `delta` with `deletes: []` and **`order: undefined`**; the client
  merges in place and cannot drift (`keyed-delta-merge.ts:50`). A membership delta **always ships
  the full `order`** (`resource-runtime/CLAUDE.md:116`) and the client rebuilds the array from it;
  any id it can resolve from neither the upserts nor its own base is drift ⇒ `forceFullResub`
  (`notifications-client.ts:1626`). For a 0-or-1-row value that `order` is pure overhead and pure
  new risk.
- **It changes the persistence contract.** `membershipBounded()` (`:2320`) feeds
  `boundedMembershipKeys()` (`:1160`), which `live-state-snapshot`'s boot init uses to **delete**
  leftover persisted L2 rows for keys that became bounded. Point membership is a persistence
  decision wearing a routing hat.

None of that is wanted here. The resource has no collection, no order, no membership.

### The insight this plan is built on

For these resources the fan-out is a **routing** problem, not a diffing problem. The owning tuple
already receives exactly the right frames today — a `doc-update` UPDATE already reaches it as
`affected = { blockId }` on the legacy scoped path. The only defect is that N−1 other tuples are
woken too.

So: **narrow who is scheduled, and change nothing else.**

## Approach

### 1. `rowIdentity` — a third answer to "which tuple owns a changed row?"

Add to `ResourceDefinition` (after `membership`, `runtime.ts:294`) and mirror it in
`ServerResourceOptions` (`:502`) and `contractToDefinition` (`:544`):

```ts
/**
 * The params tuple names EXACTLY ONE row of `identityTable`; this returns that
 * row's primary key. A ROUTING declaration only: it changes which subscribed
 * tuples a change is scheduled for, never what the owning tuple computes or
 * receives — that stays on the legacy scoped/FULL drain. It is deliberately not
 * `membership`: a 0-or-1-row value has no membership and no order, and a
 * membership delta must assert `order`, which is a client-drift surface bought
 * for nothing.
 */
rowIdentity?: (params: P) => string;
```

What each op does, before and after — the last row is the entire intended change:

| change | today (fan-out) | `rowIdentity` | `membership:{point}` (rejected) |
| --- | --- | --- | --- |
| `U` on the owning id | scoped delta, `order: undefined` | **identical** | membership drain, asserts `order` |
| `I` on the owning id | FULL drain → `diffKeyed` | **identical** | scoped membership diff, asserts `order` |
| `D` on the owning id | FULL drain → `diffKeyed` | **identical** | zero-loader delete, `deletes` + `order` |
| `ids: null` (bulk / >7 KB) | FULL to every tuple | **identical** | FULL to every tuple |
| any op, non-owning tuple | scheduled, reads, ships nothing | **not scheduled** | not scheduled |

**Runtime edits, all in `core/runtime.ts`:**

- **`createResource` (after the membership guards, `:1922`)** — four loud registration throws:
  requires `mode: "keyed"`; requires `identityTable`; mutually exclusive with `membership` *and*
  `scopedMembership`; **incompatible with `bootCritical`** (the L2 boot init and
  `recomputeResource` (`:4634`) schedule the `{}` tuple, for which `rowIdentity({})` is
  meaningless — and `bootCritical` ⇒ `shouldPersist` is the exact predicate). Store it on the
  registry entry beside `identityTable` (`:2007`); do **not** normalize it into a
  `MembershipRecord`.

- **`applyDbChange` (`:4508–4595`)** — two edits, the first load-bearing.

  **(i)** Inside the identity-origin arm (`:4509`, after the `identityBase` guard at `:4513`),
  record `identityOrigin = true` and `routeIds = hasIds ? new Set(change.ids!) : null`.
  `affected` **cannot** be reused as the filter condition: `rowIdentity` must filter op-`I`/`D`
  where `affected` is deliberately `null`, and a `null` `affected` also arises from the
  *uncovered-dependency* arm (`:4541`) where `change.ids` live in a **foreign key space** —
  intersecting there would silently drop deliveries. Filter only when
  `identityOrigin && routeIds !== null`. (The existing point filter at `:4567` is safe only
  because `affected !== null` happens to imply the identity arm today; `rowIdentity` must not
  lean on that coincidence.)

  **(ii)** Target selection and the per-tuple filter, before the point block:

  ```ts
  const rowIdentity = entry.rowIdentity;
  const targets = pointMembership || rowIdentity
    ? subscribed                                    // no `[{}]` fallback: params ARE a row id
    : subscribed.length > 0 ? subscribed : [{}];
  …
  if (rowIdentity && identityOrigin && routeIds !== null) {
    if (!routeIds.has(safeRowId(entry, rowIdentity, params))) {
      if (entry.ackChannel && change.xid !== undefined)
        scheduleNotify(entry, params, new Set<string>(), { source: "feed", sourceTx: change.xid });
      continue;
    }
    // Owning tuple: fall through with `affected`/`deleted` UNCHANGED.
  }
  ```

  `safeRowId` fails **open** (a throw ⇒ treat as matching, plus `reportLoaderError`), mirroring
  `safeOrderSig`'s "unknown ⇒ do the expensive thing" convention at `:2364`. Without it a
  throwing `rowIdentity` lands in `applyDbChange`'s swallowing `catch` (`:4620`) and silently
  drops **every** delivery for that change, across every resource.

  Do **not** narrow `tupleAffected` to `{rowId}`. Leaving `affected` exactly as computed is what
  makes "byte-identical for the owner" literally true.

- **`drainEntry` (`:3226`)** — `if (affected !== null && affected.size === 0 && !persisted) continue;`
  drops the ack-only pending (ii) can now schedule. Change the bare `continue` to
  `broadcastAckOnly(entry, pendingEntry); continue;` — inert unless `ackChannel` is declared, so
  no existing resource moves. Otherwise: **no change to `drainEntry`.** `rowIdentity` is
  deliberately absent from the `if (entry.membership)` branch.

- **No reverse `rowId → tuple` index.** It would be O(changed ids) instead of O(subscribed
  tuples), but the per-tuple work is already only a property read — what is being deleted is 200
  Postgres round trips, not 200 closure calls. An index adds a second source of truth for
  subscription state that must stay in lockstep with sub / unsub / socket close / `sub-batch`
  replay. Record the crossover in the comment (revisit above ~10⁴ tuples per key, or if
  `applyDbChange` shows up in a CPU profile once the fan-out is gone) and do not build it.

### 2. Apply it

```ts
export const blockContentServerResource = defineResource(blockContentResource, {
  loader: ({ blockId }) => loadBlockDoc(db, blockId),
  identityTable: "page_block_docs",
  rowIdentity: ({ blockId }) => blockId,
});
```

Same for `todoTaskServerResource`. Replace both files' long "this fans out and here is why we
cannot fix it" comments with a short statement of what `rowIdentity` guarantees, and correct the
false POINT-membership claim in `…/todo/task-link/shared/schemas.ts`. Add a section to
`plugins/framework/plugins/resource-runtime/CLAUDE.md` beside "Bounded membership" stating the
three-way scope answer and, explicitly, why `rowIdentity` is not `membership: { kind: "point" }`
with one id.

### 3. Make the fan-out unspellable (the structural half — research F2)

`ScopePolicy` (`:392`) already forces a keyed resource to answer *"scoped or FULL?"*. Extend it to
the second question it leaves unasked — a keyed `identityTable` resource must supply exactly one
of `rowIdentity` | `membership` | `fanOut: { reason: string }`:

```ts
export type ScopePolicy<P extends ResourceParams = ResourceParams> =
  | { identityTable: string; rowIdentity: (params: P) => string; membership?: never; fanOut?: never; recompute?: never }
  | { identityTable: string; membership: KeyedMembership<P>;     rowIdentity?: never; fanOut?: never; recompute?: never }
  | { identityTable: string; fanOut: { reason: string };         rowIdentity?: never; membership?: never; recompute?: never }
  | { recompute: { kind: "full"; reason: string }; identityTable?: never; rowIdentity?: never; membership?: never; fanOut?: never };
```

`fanOut` normalizes to nothing in `createResource` — a declaration requirement, byte-identical at
runtime, exactly the precedent the existing `recompute: { kind: "full", reason }` arm sets. Note
it must be a **sibling** of `membership`, not a variant inside `KeyedMembership`: a `kind:"fan-out"`
member would make `entry.membership` truthy at `:3211` and `:4522`, which is the reroute being
avoided.

Only **seven** call sites are keyed and need an arm. Seven more declare `identityTable` in
`mode: "push"`, which `ScopePolicy` does not govern — leave them alone (say so in the commit, so
nobody "fixes" them):

| site | arm |
| --- | --- |
| `page/editor-collab/server/internal/resource.ts:33` (`page_block_docs`) | `rowIdentity` |
| `page/annotations/todo/task-link/server/internal/resource.ts:31` | `rowIdentity` |
| `page/annotations/agent-notes/authorship/server/internal/resource.ts:23` | `fanOut` — composite PK ⇒ the trigger emits `ids: NULL` (`triggers.ts:135`), so there is nothing to intersect. Reason already written at `:11–21`; lift it verbatim. |
| `page/prompt/link/server/internal/resource.ts:32` | `fanOut` — params key a foreign column (PK is the task id). Reason at `:20–29`. Its loader already honours `ctx.affectedIds`, so only the call count fans out. |
| `tasks/tasks-core/server/internal/resources.ts:160` (`pushes-by-attempt`) | `fanOut` — same foreign-column shape |
| `tasks/tasks-core/server/internal/resources.ts:186` (`attempts`) | `fanOut` — param-less, one tuple |
| `conversations/agents/server/internal/resources.ts:34` (`agent-launches`) | `fanOut` — param-less, one tuple |

**The inventory AS VERIFIED (this table supersedes the one below, which was derived from a grep
and an assumption).** Seven keyed sites need an arm, and that count was right:

| site | arm taken |
| --- | --- |
| `page/editor-collab` (`page_block_docs`) | `rowIdentity` |
| `page/annotations/todo/task-link` (`page_blocks_ext_todo_task`) | `rowIdentity` |
| `page/annotations/agent-notes/authorship` (`page_blocks_agent_authors`) | `fanOut` — composite pk, the feed emits no ids |
| `page/prompt/link` (`tasks_ext_prompt_block`) | `fanOut` — params key a foreign column |
| `conversations/agents` (`agent_launches`) | `fanOut` |
| `tasks-core` pushes-by-attempt (`pushes`) | `fanOut` |
| `tasks-core` attempts (`attempts`) | `fanOut` |

plus `tasks-core`'s conversations / tasks resources, which already carried `scopedMembership: true`
and so already answered.

**But the "seven push-mode sites" claim was wrong: there are five.**
`events-core` (events, event_source_runs), `mail/sync`, `mail-core/labels`, `mail/threads`
revision — all `mode: "push"`, ungoverned by `ScopePolicy`, correctly untouched. The remaining two
`identityTable:` occurrences I had counted are `View({ view, identityTable })` contributions in
`tasks-core/server/index.ts` — the **derived-views** mechanism, an entirely different thing that
happens to share the field name. Do not "fix" them.

`ScopePolicy` did have to become generic in `P` (`ScopePolicy<P>`), the one risk the plan flagged
as possibly making this harder than assumed. It did not break inference at any call site.

Compilers: `query-resource/server/internal/compile-window.ts:133,264` already emit real
`membership` and satisfy the arm unchanged. `compile.ts:135` (plain `queryResource`) must emit
`fanOut: { reason: "the params tuple is the whole compiled query, not one identity row" }` —
deriving `rowIdentity` when the spec's `where` is exactly `eq(pk, params.X)` is a separate,
larger idea. **Both compilers build their opts with an `as … & ScopePolicy` cast, so `tsc` will
not catch a missing arm there** — which is why the check below is not optional.

Extend `plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/check/index.ts`
(its `markerCallSpans` / `parseStringField` machinery already walks every `defineResource` call
and skips test paths): a keyed `defineResource` declaring `identityTable` must also declare
exactly one of the three. No new lint rule — the check plugin *is* this repo's mechanism for
declaration shapes, and it already runs inside `./equin build`.

**No docgen change.** `resource-vocabulary` classifies *client descriptor factories* by return
type (`vocabulary.ts:125–164`); `rowIdentity` is a server-opts field on an existing
`keyedResourceDescriptor`, so it mints no factory and `plugins-doc-in-sync` stays green.
Deliberately do **not** add a client `rowIdentityResourceDescriptor`: it would force a vocabulary
entry and a docgen `membership` value that is a lie, for a fact the browser never uses.

## Order of work

Three separate, individually shippable changes:

1. **`rowIdentity` in the runtime + unit tests + the two consumers.** Small, reversible,
   measurable. Ship and measure before anything else.
2. **The `fanOut` arm**: `ScopePolicy` widening + the seven keyed declarations + the two compiler
   emit sites. Zero runtime behaviour change, large mechanical churn — better done after (1), so
   the survey runs against already-correct resources. Each `fanOut` reason must be a real sentence
   about that resource; a wrong reason is worse than none.
3. **The `keyed-resource-scope` check extension** (the backstop for the compiler casts).

Preceded by Step 0 and Step 1 below, which are throwaway.

**Execution.** The code-writing steps go to Opus subagents, one per shippable change, each given
this doc plus the exact file/line anchors it needs: (1) the runtime `rowIdentity` change and its
unit-test file, (2) the `ScopePolicy` third arm and the seven declarations, (3) the
`keyed-resource-scope` check extension and the new e2e script. Step 0 / Step 1 (baselining and the
throwaway probe) and the final measurement stay in the main session, since they are
run-and-interpret work whose output decides whether (1) proceeds at all.

## Verification

### Step 0 RESULT (2026-08-25) — the symptom reproduces on `main`, with no declaration at all

Baselined against `http://equin.localhost:9000`, scripts run serially, ~8 s apart, on a
machine also running two type-check workers (so read the failures as "at least this bad", not as
a clean-machine measurement):

| script | result on main |
| --- | --- |
| `crdt-split-merge-verify` | **17/17 pass** — incl. "converge: context B matches" |
| `crdt-typing-verify` | **4/4 pass** — incl. cross-context convergence |
| `crdt-reopen-verify` | **7/7 pass** |
| `crdt-multitab-agent-verify` | **8/8 pass** — incl. one shared socket across tabs |
| `crdt-adjacent-surfaces-verify` | 2/5 fail — `[[page]]` token projection, backlink registration |
| `crdt-newblock-verify` | 1/6 fail — `CONVERGENCE — got ["","","","","",""]` |
| `crdt-offline-verify` | 1/9 fail — `second context converges — ""` |

**The two failures are the reverted attempt's alleged regression, on `main`, with neither
`membership` nor `rowIdentity` declared anywhere.** `crdt-newblock-verify` renders a second
browser context's SIX blocks as six empty strings; `crdt-offline-verify`'s
`second context converges` check gets `""`. "A second browser context opening a page that another
context already has open renders the block's text as empty" is a verbatim description of these
two checks failing.

So the F1 revert rests on evidence that does not distinguish F1 from `main`. That is why no
mechanism was ever found: there was nothing in F1 to find. It does **not** prove F1 was harmless —
F1 also rerouted INSERT/DELETE onto the membership differ (see above), which these scripts do
exercise and which nobody measured separately — but it does remove the only reason recorded for
abandoning the scoping work.

It also means **this repo has a live second-context hydration bug on `main`, asserted by two
e2e scripts, that the 2026-08-24 hydration guard did not fully close.** That is not this task's
defect, and `rowIdentity` neither causes nor cures it. It matters here for exactly one reason:
these two scripts CANNOT be used as the pass/fail gate for the scoping change, and any future
attempt that treats them as one will reach the same wrong conclusion F1 did. Filed separately.

**And the cause is measured, not guessed.** The new `crdt-fanout-verify.ts` waits on the condition
instead of on a clock, and it reports how long the wait actually is. On an IDLE machine, against
main, a second browser context took **6391 ms** and **6237 ms** (two runs) to render every block's
text after `goto`. The three scripts above wait a fixed **5000 ms**
(`crdt-offline-verify.ts:127`, `crdt-newblock-verify.ts:136`, `crdt-typing-verify.ts:82`).

So they are not "flaky under load" — they sample the DOM roughly a second and a half BEFORE the
app is ready, and pass only when the read happens to land on a partially-converged page that
still satisfies the assertion. The same page `crdt-fanout-verify` declares fully good at 6.4 s is
declared EMPTY at 5 s.

That closes the question. There is no evidence of a second-context hydration bug on main: the
instrument was reading too early. And it means **any** change to this area — scoping, timing,
anything that shifts convergence by a few hundred milliseconds — can turn one of those three red
without breaking a thing. That is precisely how F1 died, and it will happen again to the next
attempt unless the instrument is fixed.

**Therefore, before the scoping change can be verified at all, the three fixed waits must become
condition waits.** The polling helper belongs in the shared harness
(`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e`), not copied per script — four
scripts need it, and a fourth hand-rolled copy is how the fixed waits got there. This is a
prerequisite of the verification, not a nice-to-have: a gate that fires on a clock cannot tell a
regression from a slow machine.

Corroborated by a repeat run of just the two failing scripts: `crdt-offline-verify`, which had
failed `second context converges — ""` in the baseline, **passed 9/9**; `crdt-newblock-verify`
failed again but with a DIFFERENT shape — `got []`, an empty array, meaning it read before any
block rendered at all rather than reading six empty ones. Non-deterministic, and varying in the
direction of "read even earlier". A third run died in setup (`openBlankPage` timed out waiting 30 s
for the "Blank page" tile) on a machine then running two type-check workers plus Playwright — an
infrastructure failure, not a result, and the reason the repeat run was stopped rather than
finished. The idle-machine 6.4 s measurement is the stronger evidence and it already answers the
question.

### Step 0 CONCLUSION — the instrument was fixed, and the failures went away

`waitFor(read, ok, {timeoutMs, intervalMs})` now lives in the shared harness
(`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/wait.ts`, exported from that barrel).
It reads before sleeping — so a ready app costs 0 ms — and returns `waitedMs` / `attempts`, which
is the only reason any of the numbers in this document exist. Four scripts now use it.

All four pass against main, and the margins are not marginal:

| assertion | needed | fixed wait it had |
| --- | --- | --- |
| `crdt-offline` second context converges | **9733 ms** | 5000 ms |
| `crdt-newblock` CONVERGENCE | **8741 ms** | 5000 ms |
| `crdt-fanout` context B renders every block | 7761 ms | (condition wait) |
| `crdt-fanout` context B re-hydrates after reload | 6502 ms | (condition wait) |

No assertion was weakened; only when each one reads. **No product bug is required to explain
either failure, and none appeared once the scripts genuinely waited.** The F1 revert was a
measurement artifact.

Three things found while converting, all of which would otherwise have been read as regressions:

- **The named line was never the only one.** `crdt-newblock` also had a fixed
  `waitForTimeout(3500)` before reading DOM / docs / projection: fixing only the 5000 ms turned
  CONVERGENCE green and DOM/DOCS red — five blocks instead of six, two `page_block_docs` rows
  "never created" that existed moments later. Same defect, one arm earlier. `crdt-typing` had a
  fixed 1800 ms before its cross-context read. Both converted.
- **`crdt-fanout-verify` itself had a one-shot read** ("every block has a `page_block_docs` row")
  and it failed on a loaded run — two blocks had no row *yet*. A script written about fixed waits
  still shipped with one. That is how ordinary this mistake is, and it is the argument for the
  helper living in the harness rather than in anyone's judgement.
- **The default budget is 45 s, sized against a measurement**, not a guess: the worst HEALTHY wait
  observed was 20.9 s (context B re-hydrating while three other runs shared the machine). A
  condition wait returns the instant the app is right, so the idle case never pays it; the budget
  exists for the loaded case, because the loaded case is the one that manufactures a false failure.
  30 s would have been 1.4× headroom over an already-observed case — which is exactly the reasoning
  that produced the 5000 ms.

Unrelated formatting churn rides in the diff of the converted scripts: their committed bytes do not
satisfy the installed prettier 3.9.6, so touching them puts them in the branch's changed set and
the format pass rewrites them. Pre-existing, not introduced here.

Separately flagged, not folded in: the browser logs `net::ERR_ABORTED` for
`POST /api/blocks/:id/doc-update` where a page unmounts or navigates. An aborted `doc-update` is
in principle a lost write. It happens on main today, `crdt-fanout-verify` deliberately does not
assert on it, and turning it into a check deserves its own script and its own task.

### Step 0 — baseline `main` first, one script at a time

`crdt-offline-verify.ts:127`, `crdt-newblock-verify.ts:136` and `crdt-typing-verify.ts:82` all use
a fixed 5 s wait after `pageB.goto`, and the cleanup doc records all three flaking on a loaded
machine. Run them **individually**, not back-to-back, and record exact pass/fail counts. Without
this table Step 1 cannot be interpreted — this is precisely how F1 was killed.

```
bun plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts              --base http://equin.localhost:9000
bun plugins/page/plugins/editor/e2e/crdt-reopen-verify.ts                   --base …
bun plugins/page/plugins/editor/e2e/crdt-typing-verify.ts                   --base …
bun plugins/page/plugins/editor-collab/e2e/crdt-multitab-agent-verify.ts    --base …
bun plugins/page/plugins/editor-collab/e2e/crdt-adjacent-surfaces-verify.ts --base …
bun plugins/page/plugins/editor-collab/e2e/crdt-newblock-verify.ts          --base …
bun plugins/page/plugins/editor-collab/e2e/crdt-offline-verify.ts           --base …
```

### Step 1 — the empirical probe (throwaway commit, discarded after)

Re-apply the naive `membership: { kind: "point" }` on today's HEAD, build, re-run the same list
with the same discipline, and diff against Step 0.

- **Same failures as baseline** ⇒ there was never a runtime defect; the F1 revert was a
  misattribution to the known flake plus the client blind-binding race that `7c179da4e`'s
  hydration guard fixed on 2026-08-24, the day *after* the revert.
- **A new failure** ⇒ expect it in split / merge / new-block, i.e. the INSERT/DELETE →
  membership-diff conversion at `:4522` — the change `rowIdentity` specifically does not make.
  Record the failing check and move on; do not debug a path we are not shipping.

Write the finding into this doc either way. If it is a genuine runtime defect it also affects the
seven production point-membership resources and needs its own task.

### Step 2 — runtime unit tests

New `plugins/framework/plugins/resource-runtime/core/runtime-row-identity.test.ts`, copying the
harness shape from `runtime-window-membership.test.ts:765–820` (`createHarness({readSet, sockets:2})`,
`feed(op, ids)`, `deltas(h, key)`), with a loader that **ignores `ctx.affectedIds`** — that is the
shape under test.

1. `U` on `a` reaches only the `{id:"a"}` tuple; **assert the loader call count**, not just the
   absent frame — the absent frame is what hid this defect for months.
2. `I` on `a` reaches only `a`'s tuple, as a FULL recompute.
3. Same for `D`.
4. **The equivalence test, the most important one:** two entries over the same table, one with
   `rowIdentity` and one without, one tuple each on the same id; feed I / U / D / `ids:null` and
   assert the owning tuple's frame streams are deep-equal. This pins "the only behavioural change
   is that non-owning tuples are not scheduled" as a test rather than a comment.
5. `ids: null` (bulk / over-cap) reaches **every** subscribed tuple, FULL.
6. A change on an **uncovered** read-set table (foreign key space, `:4541`) reaches every tuple and
   is **not** filtered. Without this test a later refactor deletes the `identityOrigin` guard.
7. A change arriving via a **secondary view** (`identityBase !== identityTable`) is still dropped.
8. Zero subscribers ⇒ no `[{}]` pending.
9. Registration throws: no keyed mode; no `identityTable`; with `membership`; with
   `scopedMembership`; with `bootCritical`.
10. A throwing `rowIdentity` fails open (delivery still happens) and reports.
11. `ackChannel` + non-matching change ⇒ exactly one standalone `ack`, no version bump, no delta.

Plus a `// @ts-expect-error` fixture proving the third `ScopePolicy` arm rejects an
`identityTable` with no answer.

### Step 3 — browser e2e on the real change

`./equin build` (background; the verdict is the receipt at
`~/.singularity/worktrees/<wt>/build-status.json`), then the same seven scripts one at a time
against this worktree's own deploy, diffed against the Step-0 table. The discriminating property:
*two clients on the same block both receive the push, while a different block's write reaches
neither* — asserted by `crdt-multitab-agent-verify.ts` and `crdt-adjacent-surfaces-verify.ts`.

Add one new script, `plugins/page/plugins/editor-collab/e2e/crdt-fanout-verify.ts`, pinning the
fix and the old symptom in one run: several blocks, context A types in one, context B opens the
same page, assert (a) both converge on that block, (b) every other block still shows its own text
in both contexts, (c) a reload with a block open still shows its text (R2 below).

### Step 4 — measure

After a comparable typing session:

```sql
select operation, count, max_ms from slow_ops where operation like '%page-block-doc%';
select kind, count, last_seen_at from reports where kind = 'live-state-noop';
```

`sub:page-block-doc` max_ms is the number that proves it, and the `live-state-noop` row for
`page-block-doc` should disappear entirely: a non-owning tuple now runs no recompute, so it emits
no `onPush(changed:false)` at all.

### Step 3 RESULT — no regression, and a correction about what e2e can measure

All eight CRDT scripts behave on the `rowIdentity` deploy: typing 4/4, reopen 7/7, split-merge
17/17, multitab 9/9, offline 10/10, newblock 6/6, fanout 13/13, undo 29/29 (run alone).
`crdt-adjacent-surfaces` fails 2/5, identically to main.

**And the cause of that 2/5 is now known: it is a TEST bug, not the app.** The script matches
`/\[\[([^\]:]+)\]\]/`, whose `[^\]:]+` excludes `:` — so it cannot match `[[page:<pageId>]]`, which
is exactly what `page/inline-page-link` emits. One wrong regex produces both failures: with no
match, `linkedId` falls back to an out-of-band `targetId` naming a different page, so the backlink
lookup asks about the wrong page and finds nothing. So the honest statement is stronger than
"pre-existing and unrelated" — the app is correct and the test's pattern is wrong. Not fixed here
(it is test DESIGN, not a wait); one line, worth its own change.

**Correction — an earlier claim in this document's working notes was over-read.** A single run on
the `rowIdentity` deploy showed second-context convergence at 3.9 s / 4.3 s / 5.7 s against 7.8 s /
9.1 s / 6.7 s on main, and that was reported as the fan-out removal showing up as latency. It is
not evidence of that. Later runs on the SAME deploy measured 14.0 s, 14.9 s, 24.3 s and 26.0 s —
the variable being machine load, not the code. Both sides were measured under uncontrolled and
different load, so the comparison establishes **no regression** and nothing about speed.

The controlled measurement of the fan-out is the unit test, not e2e wall-clock: over four changes
to row `a`, the fan-out twin runs the UNTOUCHED tuple `b`'s loader four times (3 FULL, 1 scoped)
and the `rowIdentity` entry runs it once — for the id-less bulk statement that legitimately cannot
be routed. That is the whole claim, and it is asserted rather than timed.

A production before/after on `sub:page-block-doc` and the `live-state-noop` rate needs matched
workloads on both instances and is not available from a few hours of e2e traffic on a fresh fork
(this worktree's DB carries no `deliver:page-block-doc` or `sub:page-block-doc` aggregate rows at
all, against main's 27 950 and 14 889 accumulated over weeks — a difference in exposure, not a
result). Worth taking after this has run on a real instance for a while; not claimable now.

## Outcome (2026-08-25) — landed and verified, not committed

Deployed at `http://att-1787619152-n12p.localhost:9000`, deploy receipt `status: ok`, `checks ✓`.

What each claim rests on — every one of these was demonstrated to FAIL when it should, rather than
merely observed passing:

- **The fan-out is gone**: the unit equivalence test asserts it by LOADER CALL COUNT. Over four
  changes to row `a`, the fan-out twin runs untouched tuple `b`'s loader four times (3 FULL, 1
  scoped); the `rowIdentity` entry runs it once — for the id-less bulk statement that legitimately
  cannot be routed. 209 pass / 0 fail.
- **The owner is unaffected**: the same test compares EVERY field of every frame (minus
  harness-synthesized ones) between a `rowIdentity` entry and a fan-out twin, so a field one path
  stamps and the other does not fails it.
- **The type rejects an unanswered `identityTable`**: pinned by `@ts-expect-error` on the
  registration-guard fixtures, which fail if the rejection ever stops happening.
- **The check catches what the type cannot see through** (the two `as … & ScopePolicy` compiler
  casts): proven by removing `rowIdentity` from `editor-collab` and watching
  `./equin check keyed-resource-scope` FAIL with the file and line, then restoring.
- **No behavioural regression in a real browser**: eight CRDT e2e scripts against the deployed
  build — fanout 13/13, offline 10/10, newblock 6/6, typing 4/4, reopen 7/7, split-merge 17/17,
  multitab 9/9. `crdt-adjacent-surfaces` fails 2/5, identically to main, from its own regex bug
  (documented above).

**Not done, deliberately, and each is its own change:**
- Step 1's throwaway probe (re-applying naive point membership to confirm it now passes with a
  fixed instrument). Redundant to the conclusion, which rests on measurement; would cost a build.
- The `crdt-adjacent-surfaces` regex fix — one line, but test DESIGN, not timing.
- The `support/optimistic.ts` bounded-retry consolidation — three independent arrivals at one
  contract is a missing primitive, and bigger than this task.
- Nothing is committed. Every change above is uncommitted in the worktree, awaiting review.

## Risks

**R1 — the fan-out is a 300 ms repair poll for *server-snapshot* divergence, and removing it makes
one divergence permanent.** The server's `entry.snapshots` is the diff base. `serveSub`
(`:3866–3870`) re-seeds the shared per-pk snapshot from a second subscriber's full read; if that
read lands after a commit whose drain has not yet run, the drain diffs fresh against fresh, ships
nothing, and the *first* subscriber never sees the change. Today the next keystroke on any block
re-reads this block's row and repairs it within ~300 ms; afterwards it needs another write to the
same block — and a block receiving its last keystroke gets none. This is the one real self-heal
the fan-out provides, and it is the most plausible way a scoping change surfaces as "renders
empty". Mitigation: the `notBefore: lastNotifyAt` flight floor (`:3260`, `:2701`) should already
cover the coalescing half — **verify it with a runtime test** (a sub-ack re-seed racing a pending
scoped drain must still deliver to the pre-existing subscriber) and, if it does not, fix that
first, on its own merits, before removing the fan-out. The client's `probeMissedUpdates` resync
(`notifications-client.ts:559`) survives as the backstop but becomes more load-bearing.

**R2 — version-counter deflation puts a dead code path into service.** `page-block-doc`'s per-pk
version currently climbs ~48/s from no-op recomputes (`:3228` bumps before the diff decides to
ship nothing). Afterwards it moves only on real changes, which makes `handleSub`'s version
short-circuit (`:3734` — same epoch + same version ⇒ `up-to-date`, **no value**) go from
almost-never to routine on reconnect and replay. The client guards it
(`notifications-client.ts:1436`: an `up-to-date` for a sub with no applied value is ignored, and
that guard's comment describes exactly this wedge), but it is a previously-dead path going live
for the editor. Covered by (c) in the new e2e script and by `crdt-reopen-verify.ts`.

**R3 — the `identityOrigin` gate is the whole correctness argument and is invisible.** A refactor
that reuses `affected !== null` as the filter condition (the shape the point code already uses)
makes `rowIdentity` start filtering foreign-key-space changes from the uncovered-dependency arm,
and deliveries vanish silently — no error, no frame, no counter. Test 6 exists for this.

**R4 — `rowIdentity` must be pure, total and synchronous**, and nothing enforces it. It runs on
the hot router path inside a swallowing `catch`. Hence `safeRowId` failing open.

**R5 — the DELETE cascade.** `page_block_docs.block_id` is `ON DELETE CASCADE` from `page_blocks`,
so purging a page deletes N doc rows in one statement; past ~190 UUIDs the ~7000-byte NOTIFY cap
(`triggers.ts:154`) drops the ids to `NULL` ⇒ FULL to every tuple ⇒ today's behaviour. Below the
cap it routes to exactly the open editors whose blocks died. Both branches are correct; test 5
documents the cap's role rather than leaving it to be rediscovered.

**R6 — this fixes reads, not writes.** `page_block_docs` takes ~3 whole-document `state` bytea
writes/s while typing, each under a `SELECT … FOR UPDATE` (`doc-store.ts:86`). Out of scope, but a
good `sub:page-block-doc` number must not be read as closing the wider question.

**R7 — `rowIdentity` overlaps `membership: {kind:"point"}` and a reviewer will ask why both
exist.** The answer must be written at the declaration site, not only here: they differ in the
drain, and the drain difference is the entire point.
