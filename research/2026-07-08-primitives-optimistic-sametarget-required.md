# Make `sameTarget` structurally required with `isConfirmedBy` in `useOptimisticResource`

## Context

`useOptimisticResource` (the optimistic-mutation primitive) confirms pending ops
against each authoritative live-state push. In **content-based** mode
(`isConfirmedBy` provided), it optionally runs a **cascade**: confirming a newer
op also drops older *resolved* ops that write the **same target**, closing the
stuck-inverse-pair hazard (undo dispatches "delete X", redo dispatches "restore
X" first → every later snapshot shows X present, confirming the redo but never
the undo → the stuck undo would replay "delete X" onto every future state
forever).

The cascade was recently gated behind an **opt-in** `sameTarget(a, b)` predicate
so it only fires within one entity — an unrelated op must never be
cascade-dropped (that would transiently revert its surface to stale server
data). But `isConfirmedBy` and `sameTarget` are currently **independently
optional**: the type permits `isConfirmedBy` *without* `sameTarget`. That
combination is exactly the latent-bug state:

- A consumer that uses `isConfirmedBy` is doing precise per-op matching because
  it has **multiple concurrent, per-entity ops in flight** — i.e. it is
  structurally multi-target.
- Such a consumer *needs* the cascade to avoid stuck ops, so omitting
  `sameTarget` silently reintroduces the stuck-inverse-pair replay.

Nothing forces the pairing today. Per the repo's "fix the structural issue —
make the unsafe combination unrepresentable" principle, we tighten the type so
`isConfirmedBy` present ⟺ `sameTarget` present, and push that guarantee all the
way down into the pure `confirmPass` so no representable-unsafe state survives
anywhere (chosen: **full structural fix**).

### Consumer survey (no consumer churn)

All four real call sites stay compiling unchanged:

| Call site | `isConfirmedBy` | `sameTarget` | Effect |
|---|---|---|---|
| `plugins/page/plugins/editor/web/block-editor-context.tsx:276` | yes | yes (`sameOverlayTarget`) | already the required arm |
| `plugins/config_v2/plugins/staging/web/internal/staged-defaults-host.tsx:68` | yes | yes | already the required arm |
| `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/web/components/use-queue-rows.ts:69` | no | no | coarse arm |
| `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx:104` | no | no | coarse arm |

The two queue consumers are structurally multi-target but use **coarse**
confirmation (no `isConfirmedBy`) — untouched. Note for a future follow-up: if
either adds `isConfirmedBy`, the new type will now *force* them to also supply
`sameTarget: (a, b) => a.conversationId === b.conversationId`. That is the whole
point.

## Approach

Encode the invariant as a discriminated union on the public args, and collapse
`isConfirmedBy` + `sameTarget` into a single `confirmation` object inside the
pure `confirmPass` so the conservative-no-cascade branch is deleted (not just
dead).

### 1. Public type — discriminated union

`plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`

Split the base fields from the confirmation pair. Keep the **flat public shape**
(two top-level fields tied by a union) so existing call sites are byte-for-byte
unchanged — do not nest them into a sub-object.

```ts
interface OptimisticBaseArgs<Data, Vars, P extends Record<string, string>> {
  resource: ResourceDescriptor<Data, P>;
  params?: P;
  apply: (current: Data, vars: Vars) => Data;
  mutate: (vars: Vars) => Promise<void>;
  onError?: (err: unknown, vars: Vars) => void;
  label?: string;
}

/**
 * Confirmation mode. Coarse (neither field) drops every resolved op on the next
 * push. Content-based REQUIRES both: precise matching implies concurrent
 * per-entity ops, which need the same-target cascade to avoid the
 * stuck-inverse-pair replay. `isConfirmedBy` without `sameTarget` (or vice
 * versa) is unrepresentable.
 */
type ConfirmationArgs<Data, Vars> =
  | { isConfirmedBy?: undefined; sameTarget?: undefined }
  | {
      isConfirmedBy: (serverData: Data, vars: Vars) => boolean;
      sameTarget: (a: Vars, b: Vars) => boolean;
    };

export type UseOptimisticResourceArgs<
  Data,
  Vars,
  P extends Record<string, string> = Record<string, string>,
> = OptimisticBaseArgs<Data, Vars, P> & ConfirmationArgs<Data, Vars>;
```

- Move the doc-comments describing the cascade/hazard onto `ConfirmationArgs`.
- This forbids **all three** unsafe/meaningless combos: `isConfirmedBy` alone,
  `sameTarget` alone, and (already impossible) is now explicit.
- `UseOptimisticResourceArgs` was `interface`; it becomes a `type` alias
  (intersection with a union). It is only referenced by the hook signature and
  the barrel re-export (`web/index.ts:4-7`) — both work with a type alias. No
  consumer names the type.

### 2. Hook — narrow the union, build the `confirmation` object

Same file, in `useOptimisticResource`.

- The current destructure `const { … isConfirmedBy, sameTarget … } = args`
  (line 82) loses the union correlation. Instead **narrow on the object** so TS
  knows the pair is present together:

```ts
const confirmation = args.isConfirmedBy
  ? { isConfirmedBy: args.isConfirmedBy, sameTarget: args.sameTarget }
  : undefined;
```

  (When `args.isConfirmedBy` is truthy, TS narrows `args` to the second union
  arm, so `args.sameTarget` is known defined — no `!` assertion needed.)
- Replace the two refs `isConfirmedByRef` / `sameTargetRef` (lines 95-96) with a
  single `confirmationRef = useLatestRef(confirmation)`.
- Update the cache-subscription call (line 115) to
  `confirmPass(prev, serverData, confirmationRef.current)`.

### 3. Pure `confirmPass` — single `confirmation` param, delete the dead branch

`plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts:97-119`

```ts
export interface Confirmation<Data, Vars> {
  isConfirmedBy: (serverData: Data, vars: Vars) => boolean;
  sameTarget: (a: Vars, b: Vars) => boolean;
}

export function confirmPass<Data, Vars>(
  pending: ReadonlyArray<PendingOp<Vars>>,
  serverData: Data,
  confirmation?: Confirmation<Data, Vars>,
): PendingOp<Vars>[] {
  if (!confirmation) {
    // Coarse: resolved + a push landed ⇒ confirmed ⇒ drop.
    return pending.filter((op) => !op.resolved);
  }
  const { isConfirmedBy, sameTarget } = confirmation;
  const confirmed = pending.map((op) => op.resolved && isConfirmedBy(serverData, op.vars));
  return pending.filter((op, i) => {
    if (!op.resolved) return true;
    if (confirmed[i]) return false;
    // Cascade within the target group: a NEWER confirmed same-target write
    // supersedes this op (the snapshot already contains its effect).
    for (let j = i + 1; j < pending.length; j++) {
      if (confirmed[j] && sameTarget(op.vars, pending[j]!.vars)) return false;
    }
    return true;
  });
}
```

- Deletes the `if (!sameTarget) return true` conservative branch (old line 111)
  — that state is no longer representable.
- Update the `confirmPass` JSDoc (overlay.ts:~72-96) to drop the "without it the
  pass is conservative" paragraph; `sameTarget` is now always present in
  content-based mode.

### 4. Tests

`plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.test.ts`

- Update every content-based `confirmPass(...)` call to pass the bundled
  `{ isConfirmedBy, sameTarget }` object instead of two positional args.
- **Delete** the "no cascade at all without `sameTarget`" test (agent-reported
  ~lines 193-201) — that combination is now unrepresentable.
- Coarse tests: `confirmPass(pending, serverData)` (omit the third arg) — behavior
  unchanged.

Add a **negative type guard** so the constraint can't silently regress. Put
`@ts-expect-error` assertions in a co-located file the `type-check` tsconfig
compiles (a `*.test.ts` next to the source, or a small `types.test-d.ts`). Each
line must genuinely error under tsc, or tsc reports the unused directive:

```ts
// isConfirmedBy without sameTarget must not type-check.
useOptimisticResource<Row[], Vars>({
  resource, apply, mutate,
  // @ts-expect-error — isConfirmedBy requires sameTarget
  isConfirmedBy: (s, v) => true,
});
// sameTarget without isConfirmedBy must not type-check.
useOptimisticResource<Row[], Vars>({
  resource, apply, mutate,
  // @ts-expect-error — sameTarget requires isConfirmedBy
  sameTarget: (a, b) => true,
});
```

(These are compile-only guards — they need not run meaningful assertions; `bun test`
executes them harmlessly and `type-check` validates the `@ts-expect-error`s.)

### 5. Docs

- `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md` — update the
  **API** block and the **Cascade confirmation** bullet: `sameTarget` is
  required with `isConfirmedBy` (not "opt-in"), and the "Without it the pass is
  conservative…" sentence is removed.
- The autogen reference block in that CLAUDE.md and `docs/plugins-details.md`
  regenerate on `./equin build` (the `plugins-doc-in-sync` check).

## Files to modify

- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts` — type + hook wiring
- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts` — `confirmPass` signature + delete dead branch
- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.test.ts` — adapt calls, drop the obsolete test
- new co-located type-guard test (e.g. `web/internal/args-types.test.ts`)
- `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md` — prose

No changes needed in any of the 4 consumers.

## Verification

1. `bun test plugins/primitives/plugins/optimistic-mutation/` — overlay logic +
   the adapted `confirmPass` calls stay green.
2. `./equin build` — runs `type-check`. Confirms:
   - the two paired consumers (page editor, config staging) still compile;
   - the two coarse consumers (queue) still compile;
   - the `@ts-expect-error` guards each consume a real error (no "unused
     directive" tsc failure) — i.e. the unsafe combos are genuinely rejected;
   - `plugins-doc-in-sync` passes after the CLAUDE.md edit.
3. Manual smoke (optional, real app at `http://<worktree>.localhost:9000`):
   exercise the page editor undo/redo and config-staging surfaces — both already
   pass `sameTarget`, so behavior is unchanged; this just confirms no regression
   from the `confirmPass` refactor.
