# One-row live reads: stop "not loaded yet" reading as "doesn't exist"

## Context

Audit page "Live resources — audit and target model", findings **B** and **C**.

What the user sees: open a task that is armed for auto-start. Its launch picker shows **Off** until the data arrives, then flips to the model. The picker is live while it says Off, so a click in that moment writes a wrong value. The conversation progress bar and the preprompt chip/icon have the same problem, without the risk of a wrong write.

Cause: `usePointResource` settles on `row | null`, where `null` means "the row doesn't exist". The domain hooks built on it also return `null` while loading, so the UI receives the same value for both states:

- `tasks/plugins/auto-start/web/hooks.ts` — `useTaskAutoStart` (`if (pending) return null`)
- `conversations/plugins/conversation-progress/web/internal/use-progress.ts` — `useProgressFor` (`pending ? null : data ?? null`)
- `conversations/plugins/conversation-preprompt/web/internal/hooks.ts` — `useConversationPreprompt`

The same bug also exists outside the three named hooks. The lint change below would flag all of these, so they are in scope:

- `tasks/plugins/task-effort/web/hooks.ts` `useTaskEffort` and `tasks/plugins/task-preprompt/web/hooks.ts` `useTaskPreprompt`. Both use a whole-collection read that returns `null` while pending, and both feed the same launch-option row. The thinking-mode and preprompt pickers show "Default" or "None" while they load.
- `conversations/plugins/conversation-category/web/internal/use-conversation-categories.ts` `useCategoryRows`. It uses `pending ? undefined : data`, so every category shows as "unset" until the data loads.

The lint rule `live-state/no-pending-data-collapse` misses all of these. It doesn't watch `usePointResource`, `usePointResources` or `useWindowResource`. It also excludes `null` returns on purpose, to allow "render nothing while loading".

**Out of scope (the later redesign):** changing what `usePointResource` returns when settled (the audit's `{found}` shape / `useLiveRow`), nullable ids (finding G), and the `select` carve-out. `usePointResource` keeps settling on `El | null`. On its settled arm, `null` really does mean "absent", so that part is correct. The bug is only in hooks that erase `pending`.

## Approach

### 1. Domain hooks pass the pending state through (never erase it)

Each hook returns `ResourceResult<T | null>` instead of `T | null`. A settled `null` then always means "doesn't exist".

- `useTaskAutoStart(taskId)` → `ResourceResult<TaskAutoStartRow | null>`. The settled arm maps `data[0] ?? null`, and the pending arm passes through unchanged.
- `useProgressFor(id)` → return the `usePointResource` result directly.
- `useConversationPreprompt(id)` → same.
- `useTaskEffort` / `useTaskPreprompt` → `ResourceResult<X | null>`. The "no taskId" case settles to `null`, which is determinate.
- `useCategoryRows` → `ResourceResult<Map<…>>`.

If a small helper is needed to map the settled arm while keeping the pending arm (for `data[0] ?? null` and the Map), look for an existing one in `live-state/web/resource-utils.ts` first. Only add a `mapResource` there if none exists, as a live-state primitive rather than a per-plugin helper.

Update the comments on these hooks, which currently say "pending also reads as null".

### 2. Components: render nothing while loading, in the sanctioned way

`PrepromptChip`, `PrepromptListIcon`, `ProgressBarToolbar`, `ProgressBarRow`, `QueuedChipAction`, `CategoryAvatarRow` and `CategoryChipToolbar` each gain an explicit `if (r.pending) return null` (or a `<Loading>`) before reading `.data`. These are small decorations on a row, and "nothing while loading" is acceptable for them. The difference from today is that the choice becomes explicit at the render site, instead of the hook deciding for every caller.

For category avatars, check what "unset" looks like. If it paints a visible "no category" glyph, render nothing while pending instead.

### 3. Launch options: the binding type gets a loading arm (the actual user-facing bug)

In `tasks/plugins/launch-options/web/slots.ts`:

```ts
export type LaunchBinding<V> =
  | { pending: true }
  | { pending: false; value: V; onChange: (next: V) => void };
```

- The three bindings (`useTaskAutoStartBinding`, `useTaskEffortBinding`, `useTaskPrepromptBinding`) map their hook's `ResourceResult` onto this union.
- The host, `BoundOptionRow` in `tasks/plugins/task-description/web/components/launch-options.tsx`, owns the loading display. While pending it keeps the label and renders `<Loading variant="block" …/>` (or a short skeleton) in the control's place. The control is never mounted with a made-up value.

This means a binding can no longer supply a value while loading: `tsc` rejects it (rung 2 of the fix ladder). The draft popover is unaffected, because it reads draft state and never calls `useTaskBinding`.

### 4. Lint: `no-pending-data-collapse` covers the bounded hooks and value-returning `null`

In `primitives/live-state/lint/no-pending-data-collapse.ts`:

1. Add `usePointResource`, `usePointResources` and `useWindowResource` to `RESOURCE_HOOKS`. Leave the existing `select` carve-out for plain `useResource` as it is. The redesign owns that decision.
2. Statement form (`if (X.pending) return null|undefined; … return …X.data…`). Today `null` is always excluded. Change it to also flag when the later **non-JSX** value return can itself produce `null`/`undefined`. The rule treats a return as able to produce null in these cases:
   - it contains a `null`/`undefined` literal (for example `?? null`, or `? … : null`);
   - it contains an optional chain (`?.`);
   - `X` comes from `usePointResource`, whose settled data is `El | null`.

   In each of these cases, the pending `null` is the same value as a real "absent", which is exactly this bug.

   Keep the JSX guard unchanged, so a component that returns `null` while pending and then renders JSX is never flagged. A value hook whose data return can never be null (for example `return r.data.length`) is not flagged either, because there `null` is a distinct "not yet" value the caller must check.
3. Ternary form: `pending ? null : …data…` on the newly watched hooks gets flagged. `null`/`undefined` already count as empty defaults there, and the select carve-out doesn't apply to them.
4. Update the header docs and the message text to explain the new rule. Add test cases to `no-pending-data-collapse.test.ts`:
   - invalid: the `useProgressFor` shape, the `useTaskAutoStart` shape (`if pending return null; return data[0] ?? null`), and the `useTaskEffort` shape (`?.level ?? null`);
   - valid: a JSX component with `if (r.pending) return null`, a hook returning `r` itself, and `if (r.pending) return null; return r.data.length`.

Then run the rule over the repo and fix every new hit. The hits expected are the six hooks above; anything else found is handled the same way (pass the pending state through) or reported if the fix isn't obvious.

### 5. Docs

- `primitives/live-state/CLAUDE.md`: one paragraph under the pending-collapse section. It says a hook built on a one-row read returns `ResourceResult<T | null>` and never returns bare `T | null`, and that the lint now enforces this.
- Update the stale comments in the `shared/schemas.ts` files that describe "row-or-null" reads, if they say pending reads as null.

## Critical files

- `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts` (+ `.test.ts`)
- `plugins/tasks/plugins/launch-options/web/slots.ts`
- `plugins/tasks/plugins/task-description/web/components/launch-options.tsx`
- `plugins/tasks/plugins/auto-start/web/hooks.ts`, `…/auto-start/plugins/launch-option/web/internal/binding.ts`, `…/auto-start/web/components/queued-chip-action.tsx`
- `plugins/tasks/plugins/task-effort/web/{hooks,internal/binding}.ts`, `plugins/tasks/plugins/task-preprompt/web/{hooks,internal/binding}.ts`
- `plugins/conversations/plugins/conversation-progress/web/{internal/use-progress.ts,components/*}`
- `plugins/conversations/plugins/conversation-preprompt/web/{internal/hooks.ts,components/*}`
- `plugins/conversations/plugins/conversation-category/web/{internal/use-conversation-categories.ts,components/*}`

## Verification

1. `./equin test plugins/primitives/plugins/live-state`: the lint rule tests (new valid and invalid cases) and the existing `window-hooks.test.tsx`.
2. `./equin test` on the touched task and conversation plugins, if they have suites.
3. `./equin check type-check`: runs `tsc` plus the lint over the whole repo. The rule must not report any unfixed hits.
4. `./equin build` (background), then E2E. Open an armed task with `screenshot.ts --path <task route>` and a slow network or a cold cache. While loading, the Auto-start row shows a skeleton, never "Off", and the model appears once the data lands. Also confirm the progress bar and preprompt chip show no wrong state.
