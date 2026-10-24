# One composer field for the Improve and Launch popovers

## Context

Today the two places you type a prompt into look nothing alike, and neither
looks designed.

**Improve** (the ✦ pill in the action bar) shows a bordered text box, and then
four loose bands stacked under it: a bare element-picker icon, then
`Auto-start [Opus 5 ▾]  Preprompt [None ▾]`, then `Thinking mode [Default ▾]`,
then a tiny `☐ URL` checkbox. Each band is its own ad-hoc `Stack` with its own
label styling, and the whole thing sits inside a *second* border (the draft
card's), so there are two nested boxes.

**Launch an agent** (the popover behind "Launch"/fork/investigate buttons) is a
different hand-rolled stack: title, description, a bordered text box, switch
rows, a full-width preprompt `Select`, and a blue split `[Opus 5 ▾│▶]` button.

The user designed the replacement as prototype `proto-1789901373-oy29`
("Improve composer field"), **Url only** variant: one field, with everything the
prompt configures living on a bar inside it.

```
┌───────────────────────────────────────────────────────────┐
│ What should be better here?                                │   ← prose
│                                                            │
│ [＋ Attach page URL]                                        │   ← attach row
│ [⊙] │ [▭ Preprompt ⌄] [◎ Dependency ⌄]   [✦ Opus 5  Auto ⌄] │   ← bar
└───────────────────────────────────────────────────────────┘
```

Set state: the attach button only *lights up* (same label, same width — it never
prints the URL); Preprompt goes amber; Dependency goes blue and reads
"Follow-up"; the run pill stays plain and reads `Opus 5  Max`.

Outcome: one `ComposerField` primitive, used by both popovers, with the bar's
pills drawn by the field from what each plugin *declares* — so the field names
no contributor, and a future launch option lands on the bar with no edit here.

Decisions taken with the user:
- **Model and thinking mode are ONE pill** with a two-group menu, as in the mock.
- **The launch popover reuses the same field, thinking mode included.** Its blue
  split `[model ▾│▶]` button goes away entirely; the model lives in the field's
  run pill and the action becomes a plain button below.
- **The launch popover keeps its current vertical order**: field, then its
  toggles, then the button.
- That button is named **Launch** — the verb this app uses everywhere else for
  starting an agent (`LaunchControl`, "Launch agent", the row action). Say the
  word and it becomes Submit/Send/Create instead; it is one string.

## What gets built

### 1. `ComposerField` — the field itself

New: `plugins/primitives/plugins/text-editor/plugins/composer/`

It wraps `TextEditor` (`plugins/primitives/plugins/text-editor/web`) and puts
the attach row and the bar into its **`bottomSlot`** — the prop that renders
content *inside* `EditorShell`'s border
(`text-editor/web/components/text-editor-impl.tsx`, `EditorShell`). That one
prop is why this is a small component: the single border, the focus ring
(`focus-ring-within`), the placeholder, markdown⇄Lexical sync, ⌘⏎ submit,
insert-at-caret (`insertRef`) and inline `<ui-context>` chips all come for free
and keep working exactly as they do now.

```tsx
<ComposerField
  {...textEditorProps}          // value, onChange, placeholder, minRows, insertRef, …
  attach={<>…</>}               // named toggle buttons; omit ⇒ no row
  barStart={<>…</>}             // icon actions, then pills
  barEnd={<>…</>}               // right-aligned
/>
```

Internally: `Stack` → optional `Cluster` (attach row, wraps) → `Line` with
`barStart`, an empty `<Fill/>`, `barEnd`. A `ComposerRule` hairline separates
the icon actions from the pills, as in the mock. Density is `sm` via
`ControlSizeProvider`.

Also exported: **`ComposerAttachButton`** — icon + label, tints when on, and
**keeps one label and one width in both states** (the v12 note in the prototype
log); the icon is the only thing that swaps (`＋` → 🔗).

> The mock's 18px corner is the one thing not reproduced: the radius belongs to
> `EditorShell` and is a theme token (`rounded-md`), not a per-call number.

### 2. `PickerPill` — icon + label(s) + chevron, opens a grouped menu

New: `…/text-editor/plugins/composer/plugins/picker-pill/`

There is no such component in the repo today — `ModelSelect`, `EffortSelect` and
`PrepromptSelect` are three near-identical `Select`s, and `LaunchControl`
hand-rolls its own checkmarks. `PickerPill` is the one home for the shape.

```tsx
<PickerPill icon={MdBolt} placeholder="Preprompt" highlight={…}>
  <PickerPill.Value>…</PickerPill.Value>      {/* strong text, first group */}
  <PickerPill.Value muted>…</PickerPill.Value>{/* dim text, later groups   */}
  <PickerPill.Group title="Model">
    <PickerPill.Item selected onSelect={…} note="default">Opus 5</PickerPill.Item>
  </PickerPill.Group>
</PickerPill>
```

- Several `Group`s in one pill = the fused control: one trigger, one menu with
  one heading per group, a checkmark on the current row in each.
- With no `Value` children it shows `placeholder` muted — which is how
  "Preprompt" and "Dependency" read before you pick anything.
- `highlight` paints the accent-tinted set state.

Built on ui-kit's `DropdownMenu` (grouped + checkmarks + per-row `note`), with
the trigger a `Button shape="pill" variant="ghost"`.

### 3. A launch option can declare how it looks on a bar

`plugins/tasks/plugins/launch-options/web/slots.ts` — `TaskLaunchOption<V>`
gains one optional field. Nothing existing changes: `component` stays required
and the task-detail Prompt card keeps rendering it unchanged.

```ts
pill?: {
  icon: IconType;
  /** This option's current value as pill text; renders nothing when unset. */
  Value: ComponentType<{ value: V }>;
  /** This option's headed group inside the menu. */
  MenuGroup: ComponentType<LaunchControlProps<V>>;
  /** Options sharing a cluster fuse into ONE pill, in registry order. */
  cluster?: string;
  /** Which end of the bar. Defaults to "start". */
  side?: "start" | "end";
};
```

Why components rather than `useItems()` data: the host renders one pill per
cluster, so a data-shaped descriptor would mean calling each member's hook in a
`.map()` — a rules-of-hooks error. A component per option is one hook scope
each, and it keeps preprompt's per-row glyph inside the preprompts plugin.

The menu heading and the collapsed placeholder are the option's existing
`label`, so there is nothing new to keep in sync.

**Highlighting is derived, not declared**: a solo pill tints when its value
differs from `def.defaultValue`; a fused pill never tints. That is exactly the
mock — amber Preprompt, blue Follow-up, plain `Opus 5  Max`.

The three contributors each gain a `web/components/*-pill.tsx`:

| option | id | cluster / side | menu group |
|---|---|---|---|
| Auto-start | `auto-start` | `run` / end | every visible model + Off |
| Thinking mode | `effort` | `run` / end | Auto + every effort level |
| Preprompt | `preprompt` | — / start | None + every configured preprompt |

The item lists stay where they already live; each provider exports one small
reader so the pill groups and the launch popover share it rather than
re-deriving it:
`useModelItems()` (`conversations/model-provider/web`),
`effortItems()` (`conversations/effort-provider/web`, from `SELECTABLE_EFFORTS`
+ `EFFORT_REGISTRY`),
`usePrepromptItems()` (`conversations/preprompts/web`, from
`useConfig(prepromptsConfig)`).

### 4. The Improve popover

`plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx` is
rebuilt around `ComposerField`. The card's own `border rounded-md p-sm` goes —
the field is now the only box — and the wrapper stays purely as the drag/pin
host for the hover drag handle and the remove ✕.

- `attach` → the "Attach page URL" button, driven by the existing
  `CardDraft.includeUrl` boolean. **No data-model change**: it is still a flag
  on the draft, `submitChain` is untouched, and it still never prints the URL.
  `UrlToggle` is deleted.
- `barStart` → `TaskDraftFormSlots.Action.Render` (the element picker's icon
  button, unchanged and still `insertText`-driven), a rule, then the
  `side: "start"` pills, then the Dependency pill. `head-toolbar.tsx` is
  deleted; its slot host moves into the bar. The picker's tooltip stays
  constant whether or not something is picked (v13).
- `barEnd` → the `run` cluster: `✦ Opus 5  Max ⌄`.
- New `launch-option-pills.tsx` replaces `launch-option-chips.tsx` **for this
  host only** — it reads `TaskLaunch.Option.useContributions()`, groups by
  `cluster`, splits by `side`, and renders one `PickerPill` per group. An option
  that declares no `pill` still renders, as its `component`, inline on the bar —
  so adding a launch option never requires touching this file.
- `relate-mode-chip.tsx` → `dependency-pill.tsx`: one `PickerPill`, placeholder
  "Dependency", group title **"Where this task goes"**, rows **As separate task
  / As follow up / As prerequisite** (v13's exact wording), same
  `TaskChainRelateMode | undefined` value as today.
- Unchanged: the chain (`+ task`, connectors, drag reorder), the footer
  Cancel/Submit, `insert-before-children`, the standalone checkbox, the draft
  persistence, and `submitChain`.

Non-head chain cards get the same field with a smaller `minRows` and no attach
row — as today.

### 5. The launch popover

`plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`:

```
<title>
<description>
┌───────────────────────────────────────────────┐
│ Extra context (optional)…                      │
│ [▭ Preprompt ⌄]            [✦ Opus 5  Auto ⌄]  │
└───────────────────────────────────────────────┘
 ⦿— Autonomous
    Let it run without check-ins
                                       [ Launch ]
```

- `LaunchAgentForm` swaps its `TextEditor` + full-width `PrepromptSelect` +
  `LaunchControl` for one `ComposerField` whose bar carries a preprompt pill
  (start) and a fused model + thinking-mode pill (end), composed **directly**
  from the three provider readers — not from `tasks.launch-option`, which is
  task-scoped and would be a category error here (there is no task).
- Toggles keep their current shape and position: switch rows with their
  description line, between the field and the button.
- The action is a plain right-aligned `Button` calling the existing
  `useLaunchConversation().launch(model)`.
- Model seeds from `useDefaultModel()` and picking one also persists it via
  `useSetDefaultModel()` — the behaviour the dropdown has today.
- `LaunchRequest` (`launch-control.tsx`) gains `effort?: EffortLevel | null`,
  forwarded into the `createConversation` body. **The endpoint already accepts
  it** (`plugins/conversations/core/endpoints.ts:25`), so this is plumbing, not
  a contract change.
- `LaunchControl` itself is **not** touched — ~20 other plugins render it
  directly (task row action, task detail, fork, reports, screenshot…), and its
  per-row hover-launch and `mod+N` shortcuts stay theirs. Only `LaunchAgentForm`
  stops using it.

## Files

New
- `plugins/primitives/plugins/text-editor/plugins/composer/{web/index.ts,web/components/composer-field.tsx,web/components/attach-button.tsx,CLAUDE.md,package.json}`
- `…/composer/plugins/picker-pill/{web/index.ts,web/components/picker-pill.tsx,CLAUDE.md,package.json}`
- `plugins/tasks/plugins/task-draft-form/web/components/{launch-option-pills.tsx,dependency-pill.tsx}`
- one `web/components/*-pill.tsx` in each of `tasks/auto-start/plugins/launch-option`, `tasks/task-effort`, `tasks/task-preprompt`

Changed
- `plugins/tasks/plugins/launch-options/web/slots.ts` (+ the `pill` type in the barrel)
- `plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx`
- `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`, `…/launch-control.tsx` (`LaunchRequest.effort` only)
- the three provider barrels + one small reader each (`model-provider`, `effort-provider`, `preprompts`)
- `web/index.ts` of the three launch-option contributors (register `pill`)

Deleted
- `task-draft-form/web/components/{head-toolbar.tsx,relate-mode-chip.tsx,launch-option-chips.tsx}` and `UrlToggle` inside `task-draft-card.tsx`

## Verification

1. `./equin build` (background), then read
   `~/.singularity/worktrees/att-1789914840-gzr4/build-status.json`.
2. Improve — empty and set, against the mock:
   ```
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --path /home --click "Improve" --viewport 1400x900 --out /tmp/improve
   ```
   Check by eye: one border; the attach button keeps its width when toggled; the
   run pill reads `Opus 5  Auto` and stays plain; Preprompt tints when set.
3. Launch — same tool, `--click "Launch"` from a task detail, and confirm the
   blue split button is gone, the pills are on the bar, and Launch sits under
   the toggles.
4. Click through by hand once: pick an element (chip lands at the caret, tooltip
   unchanged), set a preprompt, set Follow-up from a conversation, submit, and
   confirm the filed task carries preprompt, effort, auto-start model, the URL
   and the dependency edge.
5. `./equin test plugins/tasks/plugins/launch-options` and
   `./equin run plugins/tasks/plugins/launch-options/e2e/launch-options-verify.ts`
   — the existing e2e that walks every registered option on both hosts.
6. `./equin check` (plugin boundaries, `no-adhoc-layout`, typography,
   control-size, plugins-doc-in-sync).
