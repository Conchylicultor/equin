# `useEditableField` — shared primitive for debounced autosave fields

## Context

`plugins/tasks/web/components/task-detail.tsx` and `plugins/agents/web/components/agent-detail.tsx` both implement the same pattern by hand: a controlled `<input>`/`<textarea>` whose local state is debounced-saved back to the server via PATCH, while a `useEffect` re-syncs from `useResource(...)` when the server pushes a fresh snapshot.

The hand-rolled orchestration leaks a race that produces a visible cursor jump while the user is editing:

- Each field uses a `*Timer` ref. When the debounce timer fires, the callback nulls the ref **before** issuing `save()`, so during the entire async save window the sync-guard is open. Any `tasksResource` push in that window calls `setDescription(server value)`, which re-writes the textarea's DOM `value` from an external source — the browser then resets the caret to the end.
- `tasksResource` rebroadcasts on **any** activity in the cascade `recentConversationsResource → attemptsResource → tasksResource`, so the window fires often (every conversation status change, every push, every resume/exit), not just on task edits.
- `task-detail.tsx` mitigates the title with a second `titleFocused` ref. The description has no equivalent guard. `agent-detail.tsx`'s three fields (name, description, prompt) have neither — only the timer guard.

Surface symptom: editing a task description and pausing for ≥500 ms while any agent activity is happening occasionally jumps the caret to the end. The hot fix on this branch (mirror the `*Focused` pattern for description) suppresses the symptom but doubles the ad-hoc state, and `agent-detail.tsx` keeps the bug.

This plan extracts a single primitive, `useEditableField`, that handles all of: debounced save, focus tracking, server-sync suppression while the user owns the field, flush-on-blur, flush-on-demand (used by `buildLaunchRequest` / `launch`), and a `isSaving` flag for the "Saving…/Saved" indicator. Both `task-detail.tsx` and `agent-detail.tsx` migrate to it. Outcome: race eliminated by construction; both consumers shed ~30 lines of orchestration each; future fields (in any plugin) get the correct behavior for free.

## Design

### Hook signature

New file: `plugin-core/use-editable-field.ts`. Re-exported from `plugin-core/index.ts` (alongside `useResource`), consumed via `import { useEditableField } from "@core"`.

```ts
export interface UseEditableFieldOptions<T> {
  value: T;                                    // upstream (server) value
  onSave: (next: T) => void | Promise<void>;   // commit callback
  debounceMs?: number;                         // default 500
}

export interface EditableField<T> {
  value: T;                                    // local draft (bind to input)
  onChange: (next: T) => void;                 // bind to input onChange
  onFocus: () => void;                         // bind to input onFocus
  onBlur: () => void;                          // bind to input onBlur (flushes)
  flush: () => Promise<void>;                  // imperative flush (e.g. before launch)
  isSaving: boolean;                           // true while a save is in flight
}

export function useEditableField<T>(opts: UseEditableFieldOptions<T>): EditableField<T>;
```

Scoped to `T = string` in v1 (only call sites). No `equals` option — `Object.is` is sufficient for primitives, and adding the knob now would be premature for an unused dimension. If a future consumer needs object values, add it then.

### Source of truth

The hook keeps an explicit `lastSavedRef: T` — the value most recently sent to `onSave` and acknowledged. Initialized to the prop `value` on mount. **`lastSavedRef` is the single answer to "should we adopt the upstream value?" and "does `flush` need to do anything?"** The earlier draft conflated these with `isSaving` and `value` and produced a race; making it explicit removes the ambiguity.

### Internal state

- `draft: T` — `useState(value)`. Bound to the input.
- `focusedRef: boolean` — set by `onFocus`/`onBlur`.
- `timerRef: Timer | null` — pending debounce.
- `savePromiseRef: Promise<void> | null` — the currently in-flight save, if any. Used to serialize concurrent saves.
- `lastSavedRef: T` — last value the server has acknowledged (initialized to `value`).
- `onSaveRef: typeof onSave` — refs the latest `onSave` so timer callbacks don't capture a stale closure (consumers will pass inline lambdas).
- `isSaving: boolean` — derived state for UI (`useState`, flipped around the awaited save).

### Behavior contract

The sync gate is the disjunction `focusedRef || timerRef || savePromiseRef`. While any is non-null/true, the user (or an in-flight save) owns the field and upstream values are ignored. When all are clear AND `value !== lastSavedRef`, the hook adopts the upstream value.

- **Upstream sync** (`useEffect` keyed on `value` only — *not* `isSaving`): if `!focusedRef.current && !timerRef.current && !savePromiseRef.current && !Object.is(value, lastSavedRef.current)`, `setDraft(value)` and `lastSavedRef.current = value`. Keying on `isSaving` would re-fire the effect when a save resolves — but the resource push that confirms the save is asynchronous, so `value` may still hold the pre-save snapshot at that moment, and naively adopting it would clobber the just-saved value. Comparing against `lastSavedRef` instead means we only adopt genuinely new upstream changes, not echoes of our own saves.

- **`onSave` indirection**: a `useEffect` writes the latest `onSave` into `onSaveRef` every render. The timer/flush paths read `onSaveRef.current` so consumers can pass inline lambdas without `useCallback`.

- **`runSave(next)` (internal helper)**: serializes saves. Sets `isSaving = true`, awaits any existing `savePromiseRef.current`, then issues `onSaveRef.current(next)`. Stores the resulting promise in `savePromiseRef` for the duration. On resolve: `lastSavedRef.current = next`, `savePromiseRef.current = null`, `isSaving = false`.

- **`onChange(next)`**: `setDraft(next)`. Clear pending timer. Schedule a new timer for `debounceMs`. Timer callback: null the timer, then `void runSave(next)` with the value captured at scheduling time. (Capturing the value at schedule time, not read-from-state at fire time, avoids one extra source of staleness.)

- **`onFocus`**: `focusedRef.current = true`.

- **`onBlur`**: `focusedRef.current = false`. Then `void flush()`.

- **`flush()`**: if a timer is pending, clear it. If `draft` differs from `lastSavedRef.current` (`!Object.is`), call `runSave(draft)` and await it. Otherwise, await any in-flight `savePromiseRef.current` so callers genuinely have an "all writes settled" guarantee on return. **Callers (`buildLaunchRequest`, `launch`) await `flush()` and can then read `lastSavedRef`-equivalent values from `field.value`.**

- **Cleanup**: on unmount, clear the timer. Do not flush — the consumer navigated away; if they needed a flush they would have called it (e.g. `launch` does, blur does). In-flight saves continue to completion; the hook is gone but the fetch isn't cancelled.

### Why the race is gone

There is exactly one pathway by which `draft` is set from outside user keystrokes: the upstream-sync `useEffect`. Its gate closes whenever any of `focusedRef`, `timerRef`, or `savePromiseRef` is set, which together cover every moment the user (or our own pending save) has a claim on the field. The remaining adoption case — gate clear AND `value !== lastSavedRef` — is exactly "the server says something different from what we last saved," which is the only time setting `draft` can be correct. Echoes of our own saves no-op (`value === lastSavedRef`), so the cursor cannot jump from a self-induced rebroadcast.

### Critical files

| File | Change |
|---|---|
| `plugin-core/use-editable-field.ts` | **New.** ~80 lines including the serialized-save helper. The hook above. |
| `plugin-core/index.ts` | Add `export { useEditableField } from "./use-editable-field";` and the `EditableField` / `UseEditableFieldOptions` types. |
| `plugins/tasks/web/components/task-detail.tsx` | Replace the two `useState` + two `*Timer` + two `*Focused` + sync `useEffect` + two `on*Change` handlers + the `saving` flag with two `useEditableField` calls. `onSave` lambdas own normalization: `titleField`'s `onSave` is `(v) => save({ title: v.trim() \|\| "Untitled" })`; `descField`'s `onSave` is `(v) => save({ description: v })`. `buildLaunchRequest` becomes `await Promise.all([titleField.flush(), descField.flush()])`, then build the prompt from `titleField.value` / `descField.value`. Saving indicator: `titleField.isSaving \|\| descField.isSaving`. |
| `plugins/tasks/web/components/description-view.tsx` | Keep the `onFocus?` / `onBlur?` props added on this branch — the hook drives them. The component remains a pure presentation wrapper; the parent owns the hook. |
| `plugins/agents/web/components/agent-detail.tsx` | Replace the three `useState` + three `*Timer` refs + sync `useEffect` + three `on*Change` handlers with three `useEditableField` calls. `launch()` does `await promptField.flush()` before POSTing to `/api/agents/:id/launch`. The `model` field stays as-is — it's commit-on-change (`<select>`), not debounced. |

**Wire-level note.** Today, `task-detail.tsx`'s `buildLaunchRequest` sends one PATCH with `{ title, description }`. Per-field flushing sends up to two PATCHes. Intentional: PATCH is partial-update so this is semantically equivalent, the requests serialize naturally (Promise.all hits the network in parallel but each only writes the column it owns), and it's the price of one general primitive over a bespoke form-level batcher. If profiling later shows this matters, a `useEditableForm` over multiple fields can collapse them — out of scope.

**Per-field deps benefit.** A side benefit of moving each field into its own hook: today's shared `useEffect([task?.title, task?.description])` re-runs (and re-evaluates the gate) when *either* field's upstream value changes. After the migration, each field's effect keys only on its own slice, so a server-side title bump cannot disturb a description-edit gate evaluation, even pathologically.

`plugins/tree/web/internal/rename-input.tsx` is **out of scope** by user choice. Its current `dirtyRef` + commit-on-blur pattern works correctly and would force the hook into a `mode: "blur" \| "debounce"` switch we'd rather not add yet. If a future plan generalizes it, the hook can grow that mode then.

### Reused primitives

- `useResource` (`plugin-core/use-resource.ts`) — **unchanged**. The hook composes with whatever `value` the consumer threads in from `useResource`.
- No new server-side work. `tasksResource` and `agentsResource` are already correct; the bug is purely client-side.

### What stays

- The PATCH endpoints (`/api/tasks/:id`, `/api/agents/:id`) — unchanged.
- Resource notify cadence — unchanged. The hook simply ignores the rebroadcasts that previously caused the jump.
- `DescriptionView`'s click-to-edit / autoFocus / file-path button rendering — unchanged.

## Verification

End-to-end (manual, in the worktree app — required because the bug is a UI/timing artifact, not catchable by unit tests against React's reconciler):

1. `./equin build`, open `http://att-1777251022-by1g.localhost:9000/c/<conv>/tasks`.
2. **Cursor-jump regression test (the original bug):** open a task detail, focus the description, place caret in the middle of existing text, and type continuously while *also* triggering conversation activity in another tab (e.g. start/finish a conversation in any worktree — anything that fires `recentConversationsResource.notify()`, which cascades to `tasksResource`). The caret must not move. Pause >500 ms while still focused, keep an eye on it during the save round-trip — caret stays put.
3. **Server-edit acceptance:** with the description **unfocused**, mutate the task from another tab (or via the MCP `update_task` tool against the same task id). The local view must adopt the new description. Then focus the textarea and edit; the new text persists. This validates the sync gate releases correctly.
4. **Agent detail parity:** repeat (2) and (3) on `agentDetailPane` for `name`, `description`, `prompt`. Then click **Launch**: the latest prompt must reach the server (`flush()` runs before POST). Confirm by inspecting the conversation that opens.
5. **`buildLaunchRequest` parity:** in TaskDetail, type into title and description, then click a Launch button without blurring first. The launched conversation's prompt must contain the just-typed values — proves both `flush()` calls await before `save()` returns.
6. **Concurrent-flush sequencing:** type into description, wait until "Saving…" appears (i.e. a save is mid-flight), and immediately click Launch. The launch must wait for the in-flight save *and* the post-flush save (if draft drifted) before POSTing. The launched prompt must contain the latest typed text — proves `savePromiseRef` serialization works.
7. **Self-echo no-op:** focus description, type "abc", pause >500 ms (let the save complete), keep focus, do nothing. The `tasksResource` push that confirms the save must not cause a re-render that mutates `draft` (compare React DevTools: `lastSavedRef === value` after the push, gate-clear branch must early-return). Caret stays put.
8. **Saving indicator:** during fast typing the "Saving…" pill must show, then flip to "Saved" within ~500 ms of stopping. Both fields' `isSaving` should OR together correctly.
9. `./equin check` — repo validation must pass (no boundary violations from the new `@core` export).

Done when all 9 pass and the diff at `task-detail.tsx` / `agent-detail.tsx` is a net reduction in lines.
