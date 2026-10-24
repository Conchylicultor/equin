# Resources: an unknown value must be sayable, and an errored value must be unreachable

Date: 2026-07-09
Category: global (primitives/live-state, primitives/optimistic-mutation, conversations/conversation-view/{code,commits-graph,push-and-exit,drop-and-exit}, review)

Follow-up to `research/2026-07-09-global-etag-value-coproduction.md` (§5 + follow-up 2) and
`research/2026-07-08-global-absorbable-failure-guardrail.md`.

## Context

`edited-files` publishes a bare `EditedFile[]`. When the file set is undeterminable the payload
can only say `[]` — indistinguishable from a genuinely clean worktree. That `[]` is
decision-grade: `deriveExitMode` reads `files.length === 0` and arms the destructive
**Drop & Close**; the review pane renders *"No edited files."*

Today the loader **throws** for the one undeterminable case it knows about (`!worktreePath`), and
two consumers — `exit-mode.ts:65`, `drop-and-exit-button.tsx:37,67` — hand-check `.error` before
reading `.data`. Nothing enforces that a third will, and nothing stops the same mistake on any
other resource whose empty value is decision-grade.

### Correcting the premise (this changes the fix)

The brief says `useResource` hands back the descriptor's `initialData` (`[]`) alongside the error.
It does not. `pending = q.dataUpdatedAt === 0`, and React Query leaves `dataUpdatedAt` at `0` when
the **first** load fails — so a never-loaded errored resource reports `pending: true` and its
`data` is already unreachable. The settled-with-error arm is only reachable **after at least one
successful load**, and the value it carries is the *last successful* one.

That matters twice:

- **The hazard is real but differently sourced.** A worktree that was legitimately clean publishes
  `[]`; the loader then starts failing; the resource settles as `(data: [], error: Error)`. That
  `[]` is a stale-but-once-true value, not `initialData`. So a discriminated wire payload does
  **not** close the hazard on its own — a stale `{resolved: true, value: []}` under an error is
  exactly as absorbable as a stale `[]`.
- **The `!worktreePath` throw doesn't reach the guard either.** It fails on the *first* load, every
  time, so those conversations sit `pending` forever (the `sub-error` wedge, inventory item #14 of
  the absorbable-failure doc) — the `exit-error` mode never fires, and the resource re-errors and
  re-reports on every subscribe.

So there are two independent defects, and each needs its own cure:

| # | Defect | Cure |
| --- | --- | --- |
| **D1** | The settled arm exposes `data` next to a non-null `error`, so a stale value can decide. Generic: applies to every resource. | Make `data` structurally unreachable while `error` is set. |
| **D2** | The payload type cannot say "I could not determine this", so the loader's only options are *lie* (`[]`) or *throw* (wedge). | Give the payload an unresolved arm. |

D1 without D2 leaves `!worktree` conversations wedged. D2 without D1 leaves the stale-`[]` hazard
open. Both, together, make the destructive default unreachable by construction.

### The invariants to make structural

> **I1.** A resource value you can read is one the server currently vouches for. Never-loaded,
> load-failed, and known-stale are the same state to a consumer: *no value*.
>
> **I2.** A loader that has a branch where it cannot determine the value must say so **in the
> payload**. Returning the empty value is an absorbed failure; throwing is only correct for a
> *transient* failure.

## Design

### 1. D1 — `pending` absorbs `error`; the settled arm drops `error`

`plugins/primitives/plugins/live-state/web/use-resource.ts`, `core/resource.ts`

```ts
export type ResourceResult<T> =
  | { pending: true;  error: Error | null; stale?: T; refetch: () => Promise<void> }
  | { pending: false; data: T;             refetch: () => Promise<void> };
```

```ts
const hasValue = q.dataUpdatedAt !== 0;          // a real value landed at least once
const error = q.error as Error | null;
const pending = !hasValue || error !== null;     // "no trustworthy value"
```

Two properties do the work:

- **`pending` widens.** The ~97 existing `if (r.pending) return <Loading/>` gates and all 101
  `ResourceView`/`matchResource` surfaces are **unchanged and become correct for free**.
  `matchResource` already routes `pending && error` to its error branch
  (`components/resource-view.tsx:24-35`), so the loud error placeholder appears with no edits.
- **The settled arm omits `error`.** This — not the widened `pending` — is the enforcement.
  Reading `.error` off a narrowed-settled result becomes a **tsc error**, so the four sites that
  do so are enumerated by the compiler. (Typing it `error: null` would *not* break them: `null` is
  assignable to `Error | null`. The field must be absent.)

Last-known-good moves to an opt-in `stale?: T` on the pending arm — named, greppable, and never
what a `.data` read reaches. `matchResource`'s error handler takes it as a second argument
(`error?: (err: Error, stale?: GateDataOf<R>) => ReactNode`) for surfaces that prefer to keep
painting content under a transient failure.

Two mechanical details inside `useResource`:

- The manual-select branch and the cold-start primer currently key off `pending`; they must key off
  `hasValue`, or an error would re-select `initialData` / re-prime.
- The slow-resource report fires on the first `pending → settled` flip. Key it on `hasValue` so an
  error does not shift the mount→settle metric.

`combineResources` (`web/resource-utils.ts`) needs **no logic change** — it already ORs `pending`,
so one erroring input keeps the whole combine pending and carries its error. Only
`CombinedResources`' settled arm drops `error` to match.

**Compile-break burndown (4 sites, all one-liners):**

| File | Change |
| --- | --- |
| `push-and-exit/web/components/exit-mode.ts:56-65` | Check `error` *inside* the pending arm: `if (d.pending) return d.error ? {mode:"exit-error",provisional:false} : {mode:"exit",provisional:true}` |
| `drop-and-exit/web/components/drop-and-exit-button.tsx:37,67` | Delete the now-impossible `!decision.error` / `decision.error` guards |
| `review/plugins/plugin-changes/web/use-plugin-changes.ts:14` | `error: r.error` → `error: null` in the settled forward |
| `database/plugins/zero/plugins/client/web/use-zero-resource.ts:29-30` | Drop `error: null` from the settled literal (excess-property check) |

**The one real regression risk — and its cure.** `use-optimistic-resource.ts:121` reads
`result.pending ? resource.initialData : result.data`. Under the widened `pending`, a transient
error would collapse the base to `initialData` — blanking the **page block editor**
(`block-editor.tsx:177,189-192` early-returns `{rows: [], flat: []}` on `pending`) and the whole
conversation queue sidebar (`queue-view.tsx:139`, `use-queue-rows.ts:85`). Fix at the primitive:

```ts
const base = result.pending ? (result.stale ?? resource.initialData) : result.data;
// preserve the documented contract: "true until the first authoritative value"
const pending = result.pending && result.stale === undefined;
```

Optimistic surfaces therefore keep painting last-known-good under an error — the sanctioned, loud
exemption to I1 (they are editors, and `sync-status` already owns their error affordance). Surface
`error: Error | null` on `UseOptimisticResourceResult` so they can.

### 2. D2 — a payload can say "unresolved": `resolvable` in `live-state/core`

New `plugins/primitives/plugins/live-state/core/resolvable.ts`, exported from `core/index.ts`:

```ts
export type Resolvable<T> =
  | { resolved: true;  value: T }
  | { resolved: false; reason: string };

export function resolvableSchema<T>(inner: ZodType<T>): ZodType<Resolvable<T>>;
export const resolved   = <T>(value: T): Resolvable<T>;
export const unresolved = (reason: string): Resolvable<never>;
```

This is the **value-channel twin** of the pending/error gate, and the two divide cleanly:

- `error` (transient) — *we failed to determine it; retry may succeed.* Unreachable per I1.
- `{resolved: false}` (determinate) — *the server has an answer, and the answer is "there is
  nothing to determine".* A first-class value: it settles, renders, and stops retrying.

It also gives a descriptor's `initialData` a self-describing non-value (`unresolved("not loaded")`)
instead of a lie (`[]`).

### 3. `edited-files` adopts it

`plugins/conversations/plugins/conversation-view/plugins/code/`

- `core/protocol.ts` — `EditedFilesPayloadSchema = resolvableSchema(z.array(EditedFileSchema))`.
- `core/resources.ts` — `initialData` becomes `unresolved("not loaded")`.
- `server/internal/edited-files-resource.ts` — delete `missingWorktree`. Mirror commits-graph's
  `onWorktree(gone, compute)` collapse (`commits-graph/server/internal/resources.ts:43-57`), which
  already treats *no worktree* and *worktree reaped mid-compute* (`WorktreeGoneError` from
  `@plugins/primitives/plugins/commit-list/server`) as the same determinate state:
  - `loader` → `unresolved("conversation has no worktree")` / `unresolved("worktree was removed")`,
    else `resolved(await getEditedFiles(wt))`.
  - `revalidate` → the constant `"no-worktree"` for both, else `editedFilesMemo.signature(wt)`.

  The co-production invariant holds: `"no-worktree"` and `unresolved(…)` are one consistent
  signature/value pair produced from the same `onWorktree` branch. **Every other git failure still
  throws** — that is a transient failure, and I1 now makes it un-absorbable.

- Consumers narrow on `.resolved` (tsc-enforced). `exit-mode.ts` gains
  `if (!files.resolved) return { mode: "exit-error", provisional: false }` **before**
  `files.value.length === 0` is expressible — the destructive default is now unreachable by
  construction, not by a remembered guard. Display consumers
  (`review/code-review/web/components/code-review-{section,summary}.tsx`,
  `code/plugins/docs-button/web/components/docs-{pane,button}.tsx`,
  `code/plugins/file-pane/web/file-peek-pane.tsx`) render the `reason` instead of "No edited files."

### 4. `commits-graph.{delta,graph}` adopts it

`onWorktree(attemptId, EMPTY_DELTA, …)` / `"none"` is a *consistent* pair, but `ahead: 0,
behind: 0` is still a confident lie about a branch nobody measured. `shared/protocol.ts` wraps both
payloads in `resolvableSchema`; `server/internal/resources.ts` passes `unresolved("worktree gone")`
and `"no-worktree"` as the `gone` values; `EMPTY_DELTA`/`EMPTY_GRAPH` are deleted.
`web/components/commits-chip.tsx` renders a muted `—` with the reason as its tooltip;
`commits-graph-body.tsx` renders a `Placeholder`.

### 5. Docs

- `live-state/CLAUDE.md` — a new section beside "Readiness gates": **`pending` means *no
  trustworthy value*** (never-loaded ∪ errored), `stale` is the loud opt-out, and the I2 rule: *a
  loader branch that cannot determine the value returns `unresolved(reason)`; it never returns the
  empty value, and it throws only for transient failures.*
- `conversation-view/plugins/code/CLAUDE.md`, `commits-graph/CLAUDE.md` — record the unresolved arm.
- `.claude/skills/api-design/SKILL.md` — cross-link `Resolvable` from the existing
  "Failure must be a type, not an absorbable value" section as the resource-payload form of the rule.

## Rejected

- **Discriminated payload alone** (the follow-up as filed). Does not close the stale-`[]`-under-error
  hazard, and leaves `!worktree` conversations wedged `pending` forever.
- **A `decisive(result)` read** that decision consumers must remember to call. Same class of bug as
  the `.error` guard it replaces: opt-in, unenforced.
- **A lint rule.** D1 is enforced by tsc (absent field), D2 by tsc (discriminated narrow). The
  already-landed `promise-safety/no-absorbed-failure` covers `catch { return [] }`. A rule that
  could see `if (!wt) return []` across files would need type-aware cross-module analysis for a
  class the types now close.
- **Deleting `initialData` from `ResourceDescriptor`.** After D1 it is unobservable through
  `useResource` and read only by `use-optimistic-resource.ts:121`. Tempting, but it is a ~150-site
  positional-signature change orthogonal to this bug. Filed as a follow-up.

## Tests

**`live-state/web/__tests__/use-resource-error-gate.test.tsx`** (new, vitest/jsdom) — this pins the
one assumption the whole of D1 rests on, which must be **verified, not asserted**: that React Query
v5's `setQueryData` success action resets `state.error`.

- a first-load failure yields `pending: true`, `error` set, `stale === undefined`;
- a failure *after* a successful load yields `pending: true`, `error` set, `stale` = the last good
  value — and `data` is not present;
- a subsequent WS push (`setQueryData`) clears the error and re-settles with `pending: false`;
- with `{ select }`, `stale` carries the **selected slice**, not the raw payload.

**`live-state/web/resource-utils.test.ts`** (extend) — the existing `failedSettled` case
(`{pending: false, data: 1, error: err}`) is now unrepresentable; replace with *an errored input
keeps the combine pending and propagates its error*.

**`live-state/core/resolvable.test.ts`** (new, bun:test) — schema round-trip; a payload missing
`resolved` fails to parse.

**`code/server/internal/edited-files-signature.test.ts`** (update) — the existing `no worktree
throws — never [] and never "none"` case inverts: `loader` → `unresolved`, `revalidate` →
`"no-worktree"`, as one consistent pair. Add: *a `WorktreeGoneError` mid-compute collapses to the
same pair.*

**`push-and-exit/web/components/exit-mode.test.ts`** (extend) — `unresolved` files ⇒ `exit-error`;
`pending + error` ⇒ `exit-error`, not `provisional`; `resolved([])` ⇒ `drop-and-exit` still.

## Verification

1. `bun test plugins/primitives/plugins/live-state plugins/conversations/plugins/conversation-view/plugins/code/server plugins/conversations/plugins/conversation-view/plugins/push-and-exit`
2. `bun run test:dom plugins/primitives/plugins/live-state plugins/primitives/plugins/optimistic-mutation`
3. `./equin build && ./equin check` (type-check enumerates the 4-site burndown;
   `plugins-doc-in-sync` after the barrel additions).
4. **D2, the wedge:** `query_db` for a conversation with `worktree_path IS NULL` (or null one out on
   a scratch conversation), then
   `curl -s -D- 'http://<wt>.localhost:9000/api/resources/edited-files?id=<convId>'` → `200` with
   `{"resolved":false,"reason":"conversation has no worktree"}` and `ETag: "no-worktree"`, not a
   `500`. A conditional GET with that ETag returns `304`. The exit button settles on
   **Close (state unknown)**, enabled and non-destructive — never a spinner, never Drop & Close.
5. **D1, the stale-`[]` hazard:** open a conversation with a genuinely clean worktree (button reads
   *Drop & Close*), then break the loader (`chmod 000 <wt>/.git/index`, or `mv <wt>/.git`), and
   force an invalidate (`touch` a file in the worktree). The button must leave *Drop & Close* — it
   is now `pending` with an error → **Close (state unknown)**. Before this change it stays
   *Drop & Close*. Capture with `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/agents/c/<id>`.
6. **No blanking regression:** with a page open in the Pages app, break the page-blocks resource the
   same way. The editor must keep rendering its blocks (`stale` base) and surface the failure through
   the sync-status cloud — it must not blank to an empty document.
7. Commits chip on an attempt whose worktree was reaped ⇒ muted `—`, not `0 ahead`.

## Ordered implementation

1. `live-state/core/resolvable.ts` + `resolvable.test.ts` + barrel. Isolated, no consumers.
2. `live-state`: `ResourceResult` union, `pending = !hasValue || error`, `stale`, `hasValue` for the
   select/primer/report branches; `CombinedResources` settled arm drops `error`; `matchResource`
   error handler takes `stale`. New + updated tests.
3. `optimistic-mutation`: `stale`-aware `base`, contract-preserving `pending`, expose `error`.
   (Do this in the same commit as 2 — between them the block editor is blank on error.)
4. The 4-site compile burndown (exit-mode, drop-and-exit, use-plugin-changes, use-zero-resource).
5. `edited-files`: `resolvableSchema` payload, `onWorktree` collapse, `initialData`, six consumers.
6. `commits-graph.{delta,graph}`: same, plus chip + pane.
7. Docs (`live-state`, `code`, `commits-graph` CLAUDE.md; `api-design` SKILL).
8. `./equin build` (regenerates registries + docs), `./equin check`, targeted tests, then
   the manual checks 4–7.

## Critical files

- `plugins/primitives/plugins/live-state/core/{resource,resolvable(new),index}.ts`
- `plugins/primitives/plugins/live-state/web/{use-resource,resource-utils}.ts`, `web/components/resource-view.tsx`
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`
- `plugins/conversations/plugins/conversation-view/plugins/code/core/{protocol,resources}.ts`,
  `server/internal/edited-files-resource.ts`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/shared/{protocol,resources}.ts`,
  `server/internal/resources.ts`, `web/components/{commits-chip,commits-graph-body}.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/exit-mode.ts`
- `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx`
- `plugins/review/plugins/plugin-changes/web/use-plugin-changes.ts`
- `plugins/database/plugins/zero/plugins/client/web/use-zero-resource.ts`

## Follow-ups (not in this change)

- Delete `initialData` from `ResourceDescriptor` once `use-optimistic-resource` is its only reader.
- `jsonl-events` shares Skew 1, masked by `mode: "push"` (carried over from the co-production doc).
- The `sub-error` wedge (absorbable-failure inventory #14): a loader throw on the WS path still only
  `console.error`s, so `q.error` is never set and D1's gate never engages over the socket. D1 makes
  the *HTTP* path safe; wiring `sub-error` into the query's error state is the remaining half.
