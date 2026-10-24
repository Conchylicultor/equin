# Revert the TextEditor external-value guard

Supersedes the design in `2026-07-18-primitives-text-editor-value-provenance.md`
(rejected as overengineered — delete that file).
Reverts the TextEditor portion of
[`2026-07-18-primitives-text-editor-external-value-guard.md`](./2026-07-18-primitives-text-editor-external-value-guard.md).

## Context

**Symptom.** Type in the conversation prompt, press Enter. The message sends and the
text stays in the field. Typing again appends on top of the sent message.

**Cause.** `ValueSyncPlugin`
(`plugins/primitives/plugins/text-editor/web/components/text-editor-impl.tsx`) refuses
to apply any `value` change while the editor is focused, parking it until blur — and
the update listener drops the parked value on the next keystroke ("the draft wins").
`PromptInput.send()` calls `clearDraft()` after the turn POST while the editor is
still focused, so the clear is parked and then discarded. It never lands.

**Why the guard goes rather than gets a bypass.** Its stated job is to stop a
live-state echo from clobbering a focused editor. But both server-backed consumers —
`tasks/task-description` and `conversations/agents` — already read their value through
`useEditableField`, which has had exactly this guard for far longer:

```ts
if (!frozen) {
  if (focusedRef.current) return;   // use-editable-field.ts:75
```

Every other consumer (`prompt-input`, `branch`, `task-draft-form`, `launch`,
`screenshot`, `active-data/task`) owns its value locally — `useState` or `useDraft` —
and has nothing to be protected from. So the in-editor guard duplicates protection
that already exists for the two consumers that need it, while breaking the prompt bar
for the one that doesn't. It protects nobody and costs a core interaction.

**How it landed.** Commit `1a179edfe` is titled `fix(scroll-reveal): …` but bundles
three unrelated changes, each with its own research doc: the scroll-reveal primitive
(+9 migrated call sites +lint rule), `PaneResolveGuard` sticky-found, and this
+100-line editor guard. The editor change has no relationship to scrolling; it rode
along in an unrelated commit and shipped unreviewed on its own merits. Worth a
separate process follow-up.

## Change

Restore `ValueSyncPlugin` to its pre-`1a179edfe` shape. The whole inbound sync becomes
one effect again:

```ts
useEffect(() => {
  if (lastSerializedRef.current === value) return;
  selfWriteRef.current = true;
  applyMarkdownToEditor(editor, value, extensionsRef.current);
  lastSerializedRef.current = value;
  queueMicrotask(() => { selfWriteRef.current = false; });
}, [editor, value]);
```

### `plugins/primitives/plugins/text-editor/web/components/text-editor-impl.tsx`

Delete:
- `editorHasFocus()` helper (lines 248-251)
- `pendingExternalRef`, `focusedRef` (lines 276-279)
- the `applyValue` `useEventCallback` (lines 288-295) — inline it back into the effect
- the `FOCUS_COMMAND`/`BLUR_COMMAND` registration effect (lines 297-330)
- the park/carve-out branch in the value effect (lines 332-350) → the 7-line effect above
- the `pendingExternalRef.current = null` line in the update listener (line 360)
- the guard's header comment block (lines 253-261)

Also revert:
- `export function ValueSyncPlugin` → `function ValueSyncPlugin` (it was exported only
  for the test being deleted)
- the `lexical` import back to no `BLUR_COMMAND` / `COMMAND_PRIORITY_LOW` /
  `FOCUS_COMMAND` / `LexicalEditor`
- `useEventCallback` out of the `latest-ref` import (`useLatestRef` stays — still used
  by `onChangeRef`, `extensionsRef`, `InsertPlugin`, `InitialSelectionPlugin`)

### Delete `plugins/primitives/plugins/text-editor/web/__tests__/value-sync.test.tsx`

All 5 assertions pin the reverted park/drop/blur contract. There is no residual
behavior worth keeping — the pre-guard sync is "apply when it differs", which the new
e2e check below covers end to end.

### Docs

- `plugins/primitives/plugins/text-editor/CLAUDE.md` — revert the guard line.
- Prepend a superseded note to
  `2026-07-18-primitives-text-editor-external-value-guard.md` pointing here, with the
  one-line reason (duplicated `useEditableField`'s guard; broke clear-after-send).
  Keep the doc — it is the record of why the guard was tried.
- Delete `2026-07-18-primitives-text-editor-value-provenance.md` (rejected design).

### Not changed

No consumer touches. `TextEditor`'s prop contract is unchanged, so all 8 call sites
and `PromptEditor` stay as they are.

## Accepted regressions

Both narrow, neither active today, both belong in `useEditableField` if they ever
bite — that is the hook that knows a value is server-owned:

1. A **future** consumer passing a live-state `value` straight to `<TextEditor>`
   without `useEditableField` gets no focus protection.
2. The mount→autofocus ordering window in `useEditableField` (`focusedRef` starts
   `false`; `EditorShell`'s autofocus effect runs before the focus event is observed)
   stays open. One-line fix there if it ever reproduces.

## Verification

```bash
./equin build      # → http://att-1784385832-yjj7.localhost:9000
./equin check
bun run test:dom plugins/primitives/plugins/text-editor    # confirms nothing else referenced the deleted test
```

Then, via `e2e/screenshot.mjs`:

1. **Primary repro** — open a conversation, type, press Enter. The turn posts, the
   pending-turn echo appears, **and the prompt field is empty**. Before/after
   screenshots. This is the whole point.
2. **Focus retained** — type again immediately without clicking; text lands in the
   now-empty field. (The clear must not steal or drop focus.)
3. **Autosave fields still behave** — task description and the agent-detail prompt:
   click mid-text, type, pause past the autosave debounce, keep typing. The caret must
   not jump to the end and characters must not be lost — this is `useEditableField`'s
   guard doing the work the reverted code duplicated.
4. **Unmasked resets** — branch popover and task-draft popover: submit, reopen,
   confirm the field is empty.

Step 3 is the one that matters for the revert: it is the exact scenario the guard was
added for, verified to still hold without it.
