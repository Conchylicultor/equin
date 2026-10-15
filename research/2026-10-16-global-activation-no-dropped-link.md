# Activation: a dropped LinkTarget does not type-check

## Context

`Activation = (() => void) | LinkTarget` (`plugins/primitives/plugins/link-gesture/core/internal/activation.ts`).
In TypeScript a function returning anything can be assigned to one returning `void`.
So `() => openPane.to(pane, params)` is accepted as the *function* arm. A click
calls it, the `LinkTarget` it builds is thrown away, and nothing navigates.
Debug → Logs shipped this bug: `rowActivation={(e) => () => onOpen(e.id)}`, where
`onOpen` returned `openPane.to(…)`. It was fixed by hand in 58b9dae65e.
`link-gesture/no-click-navigate` cannot see it: it matches navigating calls
by name (`openPane(…)`), and a `to(…)` call going through a prop is not one.

The goal is to make a dropped link fail `tsc` (rung 2) for `Activation` and
every consumer, without adding another lint heuristic.

## Mechanism (verified with this repo's tsc 6.0.3)

The "ignore the return value" rule only applies when the target's return type
is exactly `void`. Widen it to `void | undefined` and TypeScript checks the
return type for real:

```ts
type Action = () => void | undefined;
type Activation = Action | LinkTarget;

const a: Activation = () => openPane.to(p, {});          // ✗ LinkTarget → void
const r: (x) => Activation | undefined = (x) => () => to(); // ✗ (the Logs bug)
const b: Activation = () => setFocus(id);                // ✓ (returns void)
const c: Activation = onClose;                           // ✓ (a () => void binding)
const d: Activation = () => { doThing(); };              // ✓
const e: Activation = openPane.to(p, {});                // ✓ the link arm
const f: Activation = asyncFn;                           // ✗ Promise (also a drop)
const g: Activation = () => void asyncFn();              // ✓
```

The control run, with today's `() => void`, accepts all of these. Every
consumer types its prop as `Activation` or `(row) => Activation | undefined`:
DataView / DataTable `rowActivation`, graph-canvas and workflow `nodeActivation`,
commit-list `commitActivation`, file-explorer `fileTarget` / navigator `to`,
breadcrumb, link-chip, path-bar `activationFor`, facet-table, artifact-row,
op-gantt `opActivation`, and others. So one change to the type covers them all,
and no consumer is edited for the fix itself.

## Changes

1. **`link-gesture/core/internal/activation.ts`**
   - Add and export `type Action = () => void | undefined`. Its doc comment says
     why it is not `() => void`: that would accept a function that returns a value
     and silently discard the value. A `LinkTarget` is the case that matters.
   - `Activation = Action | LinkTarget`.
   - `afterOpen` / `beforeOpen` / `runActivation` need no logic change. The
     wrappers they build have block bodies, so they are inferred as `void`.
   - Export `Action` from `core/index.ts`, but only if a consumer needs to spell
     it; otherwise keep it internal (barrel rule R13: no test-only names).
2. **Type-level regression test**: `link-gesture/core/internal/activation.test.ts`,
   a pure-logic test file that the `type-check` check compiles. It has
   `// @ts-expect-error` lines for `() => LinkTarget`, the resolver form
   `(r) => () => LinkTarget`, and `() => Promise<void>`. It also has positive
   lines for `() => voidFn()`, a `() => void` binding, a block body and a
   `LinkTarget`, plus one runtime assertion so the runner has something to run.
   The guarantee depends on a subtle compiler rule, so this test is what keeps
   it from being quietly widened back to `() => void`.
3. **Fallout sweep**: fix each site where `tsc` now rejects an activation that
   returns a value:
   - It returns a `LinkTarget`: this is a real bug. Pass the target itself
     (`(r) => linkTo(r.id)`), never a thunk.
   - It returns a Promise: write `() => void p()` (this matches the repo's
     `no-floating-promises` stance), or `await` inside a block.
   - It returns another incidental value (number, boolean, etc.): use a block
     body.

   A grep suggests this is a small set. Most activations are already
   `openPane.to(…)` / `linkTo(…)` values or calls returning void, such as
   `graph-view.tsx` `() => setFocusId(…)`. Tests that use `vi.fn()` return `any`
   and still pass. The authoritative list is
   `./singularity check type-check`.
4. **Docs**
   - `link-gesture/CLAUDE.md`: one paragraph saying the function arm is
     `Action`, and that a function returning a `LinkTarget` is a type error.
   - `lint/no-click-navigate.ts` header: one line saying a *discarded*
     `LinkTarget` is the type's job, not this rule's. The rule still covers a
     different bug: a bare navigating callback that loses ⌘/middle-click.

## Out of scope (possible follow-ups)

- Raw `() => void` props that are not `Activation`, such as React `onClick` on
  `Button` or the tree's `onSelect: (id) => void`. They can still swallow a
  `LinkTarget`. Making them reject it the same way means adopting `Action` (or
  `(…) => void | undefined`) in our own primitives' handler props, which is a
  wider sweep with more fallout. This plan does not do it.

## Verification

- `./singularity check type-check`: clean after the sweep, including the
  `@ts-expect-error` lines, which fail if the guarantee regresses.
- `./singularity test plugins/primitives/plugins/link-gesture`
- Re-introduce the Logs bug locally (`rowActivation={(e) => () => onOpen(e.id)}`
  in debug/logs) and confirm `tsc` rejects it, then revert.
- `./singularity build`, then `./singularity run plugins/debug/plugins/logs/e2e/open-log.ts`,
  plus a click-through of one DataView row (`rowActivation`) and a file-explorer
  entry, to confirm activation still works at runtime.
