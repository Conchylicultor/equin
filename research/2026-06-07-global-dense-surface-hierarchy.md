# Dense-surface hierarchy pass: sidebar list, conversation bars, task detail

## Context

The structural UI work has landed: a type/density token scale, a sanctioned
chip primitive, the `Row`/`SectionHeaderRow` primitive, and the zero-allowlist
lint guardrails (`row/no-adhoc-row`, `badge/no-adhoc-chip`,
`badge/no-badge-text-transform`, `typography-tokens/no-arbitrary-font-size`).

What remains is the **taste/polish layer that sits downstream**: the densest
surfaces still read as flat — too many elements compete at the same visual
weight, so nothing is clearly primary and the one genuinely-urgent signal
(e.g. the red pulsing `BYPASS ACTIVE`) doesn't stand out. This plan applies a
deliberate **primary / secondary / ambient** hierarchy to three surfaces using
the tokens and primitives already in place, with **no new tokens required**.

> **Note on `sidequests/ui-mastery`:** the knowledge base is still Phase 0
> (research plan only — no distilled principles doc yet). The principles below
> are derived from the existing token/primitive structure plus standard
> professional-UI practice, which is the intended fallback until that doc lands.

## Guiding principles (the hierarchy contract)

1. **Three emphasis tiers per surface unit.**
   - *Primary* (focal): the one identifier — `text-foreground` + `font-medium`/`font-semibold`.
   - *Secondary* (supporting, glanceable): the one status/action that matters now.
   - *Ambient* (peripheral): timestamps, counts, config metadata — quietest tier:
     `text-muted-foreground` + `text-3xs`/`text-2xs`, **no background fill**.
2. **Color = exception, not decoration.** A chip *background* or accent color is
   reserved for states that need attention. Neutral/at-rest states render as
   plain muted text or a `StatusDot`, never a filled badge.
3. **At most one loud element per surface unit** (row / strip / header). If
   `BYPASS ACTIVE` is present it is *the* loud thing; everything else recedes.
4. **Read-signals ≠ write-actions.** A status badge (read) must not sit at the
   same visual weight as the buttons next to it (write).

## Locked scope (confirmed with user)

- **Title strip (conversation `Conversation.Header`): untouched.** Do not move
  or remove model / category / preprompt / progress / status from the title
  strip. Out of scope for this pass.
- **Task detail Launch CTA: stays at the bottom of the description section.**
  Do not promote it into the header.
- **Sidebar row: keep every element.** No removals (category chip stays). The
  change is *muting* the icon + progress bar to the ambient tier.
- In scope: sidebar-row ambient treatment, task-header status/action separation
  + section-header standardization, `CommitsChip` color reduction, PromptBar
  single-filled-CTA, and the cross-cutting emphasis/token application (H).

---

## Surface 1 — Conversation sidebar row (keep everything; mute to ambient)

**File:** `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`

The second meta line (`ChipsSlot` + time) is the busy zone. Contributors:
`CategoryChipRow`, `PrepromptListIcon`, `ProgressBarRow`, `OpStatusChip`.

Current state of each (verified):
- `OpStatusChip` — already a single muted icon, renders nothing at rest. **No change.**
- `PrepromptListIcon` — muted icon, tooltip only. **No change** (confirm it's `text-muted-foreground`).
- `CategoryChipRow` — already `bg-muted text-muted-foreground`. **Keep** (per scope).
- `ProgressBarRow` — the one loud element: `SegmentedRenderer` paints
  `bg-success` (done) + `bg-primary` (current) segments. This is the thing to mute.

### Changes

1. **Add an ambient `tone` to the shared progress bar** so the sidebar instance
   renders in muted greys while the toolbar keeps its colored treatment.
   - `plugins/ui/plugins/segmented-progress-bar/core/types.ts` — add
     `tone?: "default" | "ambient"` to `SegmentedProgressBarProps`.
   - `plugins/ui/plugins/segmented-progress-bar/plugins/segmented/web/components/segmented-renderer.tsx`
     — when `tone === "ambient"`, swap segment fills to muted:
     done → `bg-muted-foreground/40`, current → `bg-muted-foreground/70`,
     future → `bg-muted-foreground/15` (instead of `bg-success`/`bg-primary`).
   - `plugins/ui/plugins/segmented-progress-bar/plugins/dots/web/components/dots-renderer.tsx`
     — mirror the same muted mapping so both variants honor the prop (keeps the
     collection-consumer contract: the prop is generic, every variant implements it).
   - `ProgressBarRow` (`conversation-progress/web/components/progress-bar-row.tsx`)
     passes `tone="ambient"`; `ProgressBarToolbar` keeps the default.
2. **Token cleanup in the row (H):** `ConvRelativeTime` uses `text-[10px]` →
   change to `text-3xs` (also burns down a `no-arbitrary-font-size` legacy entry).
   This makes the row's ambient tier consistent (`text-3xs` muted) with the rest.

**Result:** at-rest row = avatar (category color) + `text-xs` title + a quiet
`text-3xs` meta line whose chips/icons/bar are all muted-grey ambient; the title
is unambiguously primary. Nothing removed.

> This automatically improves the **Attempts** block in task detail, which
> re-uses `ConversationItem` rows (`task-events`).

---

## Surface 2 — Task header: separate status from actions (D) + standardize section headers (E)

**File:** `plugins/tasks/plugins/task-header/web/components/task-header.tsx`

Today the Status row is `SectionLabel "Status"` + `StatusBadge` + `Hold` button
+ `Drop` button — a read-signal flanked by two write-actions at identical weight,
with inconsistent `variant="secondary"`/`"outline"` swapping.

### D — separate read-signal from write-actions

- **Status as a quiet read-signal.** Keep the `SectionLabel "Status"` / value
  rhythm, but render the status as a `StatusDot` + muted label for neutral
  states, and only let `StatusBadge` carry a colored fill for **attention**
  states (`need_action`, `held`, `blocked`). This already aligns with
  `task-status`'s `STATUS_META` (single source of truth in
  `plugins/tasks/plugins/task-status/web`) — reuse it; do not hand-roll colors.
  - If `task-status` doesn't expose a dot color, add a `dotClass` to its
    `STATUS_META` (single source of truth) rather than coloring at the call site.
- **Demote Hold/Drop to a secondary action cluster.** Move both into one
  right-aligned group (`ml-auto`) using a consistent lighter treatment
  (`variant="ghost"`, `size="sm"`), so they read as secondary to the status
  signal. They are write-actions, visually distinct from the read row.
  - Keep using the shared `Button` primitive; the point is *consistent, lighter*
    weight, not a new control.

### E — standardize section headers

The detail sections (`task-description`, `task-dependencies`, `task-dependents`,
`task-events`, `task-attachments`, `task-preprompt`) currently mix `SectionLabel`
eyebrows and bespoke headers. Standardize each section's header to
`SectionHeaderRow variant="eyebrow"` from
`plugins/primitives/plugins/row/web` for one consistent rhythm and spacing.

- Per-section files under `plugins/tasks/plugins/<section>/web/components/*.tsx`.
- `task-header`'s internal label/value rows keep `SectionLabel` (those are inline
  field labels, not section headers) — E applies to the *section* headers each
  sibling section renders, not to the header pane's internal field labels.
- Where a section is collapsible, `SectionHeaderRow` already wires the
  `Collapsible` context (open/toggle/chevron) — prefer it over ad-hoc headers.

---

## Surface 3 — Conversation ActionBar + PromptBar

### F — tame `CommitsChip` color

**File:** `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx`

Currently shows amber (`text-warning` behind) **and** green (`text-success`
pushes) simultaneously inside one ghost button — two accents at once.

- Render all counts in the ambient tier (`text-muted-foreground`, the arrows
  already are).
- Apply **a single** accent to the one dominant/actionable state only:
  - if `behind > 0` → that count is the one signal (`text-warning`);
  - else if `pushCount > 0` → push count is the signal (`text-success`);
  - `ahead` stays muted (it's expected/ambient).
- Net: at most one colored number in the chip at any time. Keep the `MdPublish`
  icon but make it inherit the muted color unless pushes are the active signal.

### G — one filled CTA in the PromptBar

The `Conversation.PromptBar` cluster currently has multiple colored buttons:
`PushAndExitButton` (morphs `bg-destructive`/`bg-success`/`bg-primary`) **and**
`DropAndExitButton` (`variant="destructive"` red, or `bg-success/10` green).

- **Designate `PushAndExitButton` as the single filled/colored primary CTA**
  (its morphing fill is fine — it's one button changing meaning).
  - `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/...`
- **Demote the siblings to outline/ghost icon buttons** so only the primary CTA
  carries fill:
  - `drop-and-exit/web/...` — drop the `variant="destructive"` / `bg-success`
    fills; use `variant="outline"` (or `ghost`) `size="icon-sm"`, color via icon
    only if needed.
  - `hold-and-exit/web/...` and `exit/web/...` — already outline/icon; confirm
    they match the demoted treatment.
  - `drop-dependents/web/...` — same outline/ghost treatment if present in the bar.
- Net: exactly one filled action in the prompt bar; the rest are quiet icon
  buttons. The primary action is unambiguous.

---

## Cross-cutting — H: emphasis tiers + color-as-exception

Applied while touching each surface above (no separate sweep):
- Primary text → `text-foreground` + `font-medium`/`font-semibold`.
- Ambient metadata → `text-muted-foreground` + `text-3xs`/`text-2xs`, no fill.
- Replace any neutral-state filled badge with muted text or `StatusDot`.
- Reserve `Badge` *variants* (`warning`/`info`/`success`/`destructive`) for
  attention states; default everything else to `variant="muted"` or plain text.
- Any arbitrary font-size encountered (`text-[Npx]`) → named token (auto-fixable).

## Critical files

| Surface | File |
|---|---|
| Sidebar row | `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx` |
| Progress bar (shared) | `plugins/ui/plugins/segmented-progress-bar/core/types.ts`, `.../plugins/segmented/web/components/segmented-renderer.tsx`, `.../plugins/dots/web/components/dots-renderer.tsx` |
| Progress bar (row vs toolbar) | `plugins/conversations/plugins/conversation-progress/web/components/progress-bar-row.tsx` (+ `progress-bar-toolbar.tsx`) |
| Task header | `plugins/tasks/plugins/task-header/web/components/task-header.tsx` |
| Task status meta | `plugins/tasks/plugins/task-status/web` (`STATUS_META`) |
| Section headers | `plugins/tasks/plugins/{task-description,task-dependencies,task-events,task-attachments,task-preprompt}/web/components/*.tsx` |
| CommitsChip | `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx` |
| PromptBar buttons | `plugins/conversations/plugins/conversation-view/plugins/{push-and-exit,drop-and-exit,hold-and-exit,exit,drop-dependents}/web/...` |

## Reused primitives (do not reinvent)

- `Badge` + `formatStatusLabel` — `plugins/primitives/plugins/badge/web`
- `StatusDot` — `plugins/primitives/plugins/status-dot/web`
- `SectionHeaderRow` (eyebrow/title), `Row` — `plugins/primitives/plugins/row/web`
- `SectionLabel` — `plugins/primitives/plugins/section-label/web`
- `STATUS_META` (task) — `plugins/tasks/plugins/task-status/web`
- `CONV_STATUS_DOT` (conversation) — already in `conversation-item.tsx`
- Density utilities `p-chip`/`p-control`/`p-row`; type scale `text-3xs`/`text-2xs`/`text-xs`

## Non-goals / out of scope

- Title strip composition (locked: untouched).
- Moving the task Launch CTA (locked: stays at description bottom).
- Removing any sidebar-row element (locked: keep everything).
- New tokens, new density presets, or theme-engine changes.
- `task-graph` colored node icons (ambient, below the fold) — leave as-is.

## Verification

1. `./equin build` from the worktree; confirm it deploys clean (checks +
   eslint must pass — the new code must not trip `no-adhoc-row`/`no-adhoc-chip`/
   `no-arbitrary-font-size`).
2. Screenshots via `bun e2e/screenshot.mjs` at `http://<worktree>.localhost:9000`:
   - **Sidebar:** a list mixing active + completed conversations — confirm titles
     dominate, the meta line reads as one quiet ambient tier, the progress bar is
     muted grey (compare against the colored toolbar bar to confirm `tone` works).
   - **Task detail:** open a task in `need_action`/`held` (colored status) and one
     in `new`/`done` (neutral status) — confirm status reads as a quiet signal,
     Hold/Drop read as secondary, section headers share one rhythm.
   - **Conversation view:** a worktree that is behind main *and* has pushes —
     confirm `CommitsChip` shows at most one colored number; confirm the PromptBar
     shows exactly one filled action.
3. Toggle density presets (Comfortable/Cozy/Compact) in theme settings to confirm
   the surfaces still hold up (padding via `p-*` tokens, not hardcoded).
4. Diff review: `git diff $(git merge-base HEAD main)` — confirm no element was
   removed from the sidebar row and the title strip / Launch CTA are unchanged.

## Suggested implementation order

1. Shared `tone="ambient"` prop on `SegmentedProgressBar` (both variant renderers) → wire `ProgressBarRow`. Low-risk, unblocks Surface 1.
2. Sidebar row token cleanup (`text-3xs`).
3. Task header D + E (reuse/extend `STATUS_META`).
4. `CommitsChip` (F) + PromptBar (G).
5. `./equin build`, screenshot pass, iterate.
