# editable-field

Debounced-autosave field hook. `onChange` schedules a debounced save;
`flush`/`onBlur` force it; the external `value` is reconciled into the draft on
every change to either side.

## Reconcile, not drop

The external `value` (a live-state resource, in all 13 call sites) can move
under the user at any time: an agent renames the task, another tab edits, an
undo patch lands, a collaborator writes. What happens then is decided by ONE
question — does the draft carry edits no save has taken yet (`draft !==
lastSaved`)? — and the four answers are spelled out as a pure function,
`internal/reconcile.ts`:

| | meaning | what the hook does |
|---|---|---|
| `echo` | the external value IS what we last saved | nothing (self-echo suppression) |
| `adopt` | it moved on, the draft has nothing unsaved | take it — **even while focused** |
| `converged` | the draft already spells it | record the agreement; no save on blur |
| `conflict` | it moved on AND the draft has unsaved edits | keep the draft, report the divergence |

**This used to be `if (focusedRef.current) return`** — every external write to a
focused field was silently discarded, the stale draft stayed on screen, and the
next blur flushed that stale draft back over the write. A lost update with no
symptom. Focus is not the question; unsaved local divergence is.

A typing user still never has text yanked away: the `conflict` arm keeps the
draft. But the write it did not apply does not vanish either — it is exposed as
`conflict: { external }`, reported to sync-status as the `conflict` phase, and
resolvable the other way with `acceptExternal()` (take theirs, drop the draft).
The conflict clears when the two sides agree again — the user types their way to
the external value, the external value comes back as our own echo, or
`acceptExternal()` runs.

`adopt` also cancels any pending debounce: that timer would re-save the very
value being replaced.

There is no `frozen` option. It was declared, implemented in four places and
called from nowhere — a "the server owns this field, mirror it unconditionally"
escape hatch for exactly the case the reconcile now handles by default.

## Caret

Adopting into a focused field must not throw the caret to the end. The hook
finds the element through `document.activeElement` — it only ever adopts into a
focused field, and the focused element is by construction the one whose
`onFocus` set the flag, so no consumer wires a ref — and maps the offset through
the actual change (`internal/map-caret.ts`): before the edit → unchanged, after
it → shifted by the delta, inside it → the end of what replaced it. The restore
runs in a layout effect, which is after React DOM's own raw-offset restore, so
it wins. Two guards keep the `activeElement` inference honest: it must be a text
entry with a selection (an `<input type="number">` has none) and it must show
exactly the draft being replaced; otherwise there is no mapping and React's raw
offsets stand.

## Options & return

- **`label?: string`** option — human-readable name of the field. Surfaced by
  the universal sync-status indicator in the error state (e.g. "Couldn't save
  Task title") and in the conflict state.
- **`isError: boolean`** return — `true` when the most recent save rejected;
  cleared on the next successful save. The save still re-throws, so `flush` /
  callers keep their existing error-propagation semantics (and `isSaving`
  semantics are unchanged).
- **`retry: () => void`** return — re-runs the save of the current draft. Drives
  the sync-status indicator's Retry button.
- **`conflict: { external } | null`** return — the newer external value the
  draft is holding out against, for a consumer that wants its own affordance.
- **`acceptExternal: () => void`** return — resolve a conflict by taking the
  external value and dropping the draft. A no-op with no conflict.

## Auto-reports to sync-status

The hook calls `useReportSync` every render with
`phase = isError ? "error" : conflict ? "conflict" : isSaving ? "syncing" : "idle"`
(and `retry` while errored), so any surface using `useEditableField` shows the
universal Google-Keep cloud with **zero indicator code**. It is a harmless no-op
when no `<SyncStatusProvider>` is above (unit tests, non-surface mounts). A
failed save outranks a conflict: it is the state with an action attached.

It also reports an explicit **`savedAt`** timestamp (`Date.now()` set in
`runSave`'s success path, held in state) so the "Saved" cloud is reliable. The
transient `isSaving` boolean alone is lossy: a warm local socket flips it
true→false fast enough that React coalesces both updates into one `idle` render,
so the store never observes `syncing` and (under the old transition-inference)
never stamped a save. The persistent `savedAt` value can't be coalesced away.

## Tests

`internal/reconcile.test.ts` (bun) pins the policy and the caret math;
`web/__tests__/use-editable-field.test.tsx` (jsdom) pins the wiring — adoption
into a focused field, the kept draft and its conflict report, the blur that no
longer flushes a stale draft, the caret, and the debounce / flush-on-blur /
self-echo behavior that must keep holding.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Debounced-autosave field hook with focus tracking, flush-on-blur, and self-echo suppression. Used by task/agent detail forms.
- Web:
  - Uses:
    - `primitives/latest-ref.useLatestRef`
    - `primitives/sync-status.SyncPhase`
    - `primitives/sync-status.useReportSync`
  - Exports (types):
    - `EditableField`
    - `EditableFieldConflict`
    - `UseEditableFieldOptions`
  - Exports (values): `useEditableField`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deployments`
    - `apps/deploy/servers`
    - `apps/pages/page-tree`
    - `apps/sonata/library`
    - `conversations/agents`
    - `conversations/conversation-view/notes`
    - `fields/multiline-text/config`
    - `fields/text/config`
    - `tasks/automations`
    - `tasks/task-description`
    - `tasks/task-header`

<!-- AUTOGENERATED:END -->
