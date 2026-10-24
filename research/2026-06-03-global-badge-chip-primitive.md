# Badge / LinkChip primitive — unifying ~22 hand-rolled chips

## Context

There is no shared Badge/Chip primitive in `plugins/primitives/`. Instead ~30 files
hand-roll their own chip markup, and they disagree on the *same* concept:

- A "status pill" renders as `rounded-full` (conversation status), `rounded` (task
  status), `rounded-sm` (sys badge), and `rounded-md` (allow-monitor / runtime pills) —
  with no reason.
- The conversation-category chip has 2–3 different shapes across toolbar / popover / row.
- The four inline link-chips (`conv-chip`, `task-link-chip`, `attempt-chip`,
  `plugin-link-chip`) are near-byte-identical copies, plus a 5th drifted copy in the
  add-task tool view.

This per-component divergence is why the UI reads as many slightly-different small things
competing for attention. The recent typography (`text-2xs`/`text-3xs`) and density
(`p-chip`) token work now gives us real tokens to anchor a primitive on.

**Goal:** introduce a single `Badge` primitive (size × variant + a `colorClass` escape
hatch) and a `LinkChip` primitive, then migrate the core status/category/count/label
badges and the 4 link-chips onto them. Filter-toggle controls (stats toggles, notification
filters, prompt-template split-button, bell unread badge) are a *different* concept and
are deferred to a follow-up task.

Decisions confirmed with the user:
- **Variant API:** fixed prop enum + `colorClass` escape hatch (no slot registry, no `cva`).
- **Scope:** core badges + the 4 link chips; create a follow-up task for the other
  chip-like buttons.
- **Label:** no separate `Label` primitive — text-only labels are already covered by
  `section-label`; "labels" with backgrounds become `Badge` variants.

## Design principles applied

- **Mirror precedent.** Both primitives copy the `status-dot` / `placeholder` shape exactly:
  `web/internal/<name>.tsx` + `web/index.ts` barrel, `cn()` from `@/lib/utils`, boolean
  conditions inside `cn()` (never `cva`), opaque `colorClass` string prop for caller-controlled
  colors. No `definePlugin()` — a plain object `satisfies PluginDefinition`.
- **Collection–consumer separation.** The primitive owns the generic shape/size/padding/radius.
  Each domain keeps its *own* color map (`STATUS_CLASSES`, `PHASE_CLASSES`, `RUNTIME_COLORS`,
  `gitStatusBadge`, `TIER_BADGE`, `familyClass`, …) and passes the computed class through
  `colorClass`. Consumers never re-hardcode the chip geometry; only the semantic color is theirs.
- **Token-anchored sizing.** `size` maps to typography tokens (`text-3xs`/`text-xs`); padding
  uses the density `p-chip` utility. No arbitrary `text-[Npx]` or ad-hoc `px-*`.
- **One radius, theme-controlled.** Both primitives use a single **theme-derived** radius
  class — `rounded-md` (= `calc(--radius * 0.8)`, follows the shape preset: round under
  "Pill", square under "Sharp"). There is **no `shape` prop**. Note `rounded-full` is *not*
  used — it is hardcoded `9999px` and ignores the preset; the current badges' mix of
  `rounded-full` / `rounded` / `rounded-sm` / `rounded-md` is exactly the divergence being
  removed.
- **Minimal knobs — no styling escape valves.** Visual treatment is encoded as decisions,
  not exposed as options. There is no `uppercase`, `mono`, `shape`, or `tabularNums` prop on
  `Badge`: the ~6 "technical token" badges (runtime pills, git-status, the `sys` marker,
  tool-view status labels) are **normalized to normal case** and the unified text token;
  `tabular-nums` is baked into the base (harmless on non-numeric content); `mono` survives
  only on `LinkChip` for id legibility. Every prop that remains is either semantic
  (`variant`/`size`), content (`icon`/`children`), or structural (`as`).

> **Barrel `id` note:** a recent memory says plugin `id` is loader-injected and should not be
> authored. However `PluginDefinition.id` is still a **required** field in
> `plugins/framework/plugins/web-sdk/core/types.ts` and every existing barrel (incl.
> `status-dot`, added recently) still authors it. So these barrels include `id` to match
> current precedent / compile. If the loader-injection refactor has landed by implementation
> time (type becomes optional), drop `id` from both barrels.

## The primitives

### 1. `Badge` — `plugins/primitives/plugins/badge/web/`

```
plugins/primitives/plugins/badge/
├── package.json                 # @singularity/plugin-primitives-badge, private, 0.0.1
└── web/
    ├── index.ts                 # export { Badge, type BadgeProps } + default PluginDefinition
    └── internal/badge.tsx
```

```tsx
export type BadgeVariant = "muted" | "primary" | "warning" | "destructive" | "success" | "info";
export type BadgeSize = "sm" | "md";   // sm → text-3xs, md → text-xs

export interface BadgeProps {
  variant?: BadgeVariant;       // default "muted"; ignored when colorClass is set
  size?: BadgeSize;             // default "md"
  colorClass?: string;          // color-only escape hatch: replaces variant bg/text (categorical / map-driven)
  icon?: React.ReactNode;       // leading icon or StatusDot
  as?: React.ElementType;       // default "span"; "button" for interactive badges
  className?: string;           // documented escape hatch — residual one-offs only (animate-pulse, opacity)
  title?: string;
  children: React.ReactNode;
}
```

Internal class assembly (via `cn()`):
- base: `inline-flex items-center gap-1 rounded-md p-chip font-medium tabular-nums`
- size: `size === "sm" && "text-3xs"`, `size === "md" && "text-xs"`
- color: `colorClass ?? VARIANT_CLASS[variant]` where `VARIANT_CLASS` =
  `{ muted: "bg-muted text-muted-foreground", primary: "bg-primary/15 text-primary",
     warning: "bg-warning/15 text-warning", destructive: "bg-destructive/15 text-destructive",
     success: "bg-success/15 text-success", info: "bg-info/15 text-info" }`
- then `className`.

No `uppercase`/`mono`/`shape`/`tabularNums` props (see principles): all badges render
normal-case at the unified text token and the single theme-derived radius. `tabular-nums`
is in the base because it only affects digits.

The `colorClass` escape hatch is the key to migrating cleanly: the many call-sites that
already compute a color from a map keep that map and pass its value here — gaining
consistent geometry, casing, and radius while keeping their semantic colors. It is the
*only* sanctioned divergence vector, and only along the color axis.

### 2. `LinkChip` — `plugins/primitives/plugins/link-chip/web/`

The inline, clickable, navigational chip (always `bg-muted` + `text-primary` + hover
underline, baseline-aligned for inline-in-text use). Distinct interactive semantics from
`Badge`, so it is its own primitive (it may import `Badge`'s size token classes but does
not subclass it).

```tsx
export interface LinkChipProps {
  onClick: (e: React.MouseEvent) => void;
  leading?: React.ReactNode;    // StatusDot or icon (e.g. MdWidgets)
  mono?: boolean;               // monospace label (ids)
  title?: string;
  className?: string;           // e.g. max-w override
  children: React.ReactNode;    // label + optional trailing count
}
```

Renders a `<button type="button">` with:
`inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted p-chip align-baseline
text-xs text-primary hover:bg-muted/80 hover:underline`
(`gap-1` when only an icon leads, matching plugin-link-chip; expose via internal default).

> Geometry normalization: this collapses the existing `rounded` → `rounded-md`,
> `gap-1`/`gap-1.5` and `px-1.5 py-0.5`/`px-2 py-1` divergences onto the token-driven
> shape. Verify inline baseline alignment in assistant text after migration.

## Migration map (in scope)

All call-sites below were inventoried with file:line. Each keeps its own color logic and
moves geometry to the primitive.

Normalization applied everywhere below: single `rounded-md` radius, normal case (no
UPPERCASE), no monospace, `p-chip` padding, `tabular-nums` from the base.

**Badge — map-driven (`colorClass`):**
- `…/conversation-view/plugins/status/web/components/status-badge.tsx` (`STATUS_CLASSES`)
- `…/tasks/plugins/task-status/web/components/task-status.tsx` (`meta.badgeClassName`)
- `…/tasks/plugins/task-events/web/components/task-events.tsx` (`ATTEMPT_STATUS_CLASSES`)
- `…/active-data/plugins/task/web/components/task-card.tsx` (`ATTEMPT_STATUS_CLASSES`)
- `…/tool-call/plugins/task-tools/web/components/task-update-tool-view.tsx` (drop `uppercase tracking-wider`)
- `…/summary/web/components/summarize-button.tsx` + `summary-pane.tsx` (`PHASE_CLASSES`)
- `…/conversation-view/plugins/model/web/components/model-badge.tsx` (`familyClass`)
- `…/build/plugins/build-info/web/components/build-info.tsx` (status badges ×4 with dot via `icon`; trigger label)
- `…/plugin-view/plugins/runtimes/web/components/runtimes-section.tsx` (`RUNTIME_COLORS`; drop `font-mono uppercase`)
- `…/review/plugins/code-review/web/components/review-file-row.tsx` (`gitStatusBadge`; drop `uppercase` + `border` — see border note)
- `…/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx` (same)
- `…/config_v2/plugins/settings/web/components/config-field-row.tsx` (`TIER_BADGE`, sm)
- `…/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` (sm)
- `…/auth/web/components/default-provider-row.tsx` (×4 states; drop `border` — see border note)

**Badge — fixed variant:**
- `…/tool-call/plugins/add-task/web/components/add-task-tool-view.tsx` status badges ×2 (success / warning; drop `uppercase`)
- `…/conversation-ui/plugins/item/web/components/conversation-item.tsx` `ConvSysBadge` (muted, sm; drop `uppercase`, `text-[9px]`→`text-3xs`)
- `…/conversation-view/plugins/allow-monitor/web/components/allow-monitor-chip.tsx` (destructive, `as="button"`, icon, `className="animate-pulse"`)
- `…/conversation-view/plugins/dependent-count/web/components/dependent-count-chip.tsx` (muted)
- `…/conversations-view/plugins/queue/web/components/queue-view.tsx` count badges ×2 (destructive, sm) + header count ×1 (muted, sm, opacity via className)
- `…/attempt-view/web/components/attempt-pane.tsx` count badges ×2 (muted, sm)
- `…/tasks/plugins/auto-start/web/components/queued-chip-action.tsx` (warning, `as="button"`, icon; drop `border` — see border note)
- `…/plugin-view/web/components/plugin-detail.tsx` load-bearing badge (warning, sm, icon MdBolt; drop `uppercase`)
- `…/forge/plugins/catalog/web/components/catalog-view.tsx` count badge (muted, sm)
- `…/conversations-view/plugins/grouped/web/components/group-container.tsx` header count (muted, sm, opacity via className)

**Border note:** a few badges currently carry a `border` (git-status ×2, auth pills ×4,
queued chip). Borders are another geometry divergence vector. Default plan: **drop the
border** and rely on the filled variant for consistency with all other badges. If a border
proves load-bearing for a specific case during implementation, it goes through `className`
as a documented one-off exception — surface it in review rather than re-adding silently.

**Category chips** — `…/conversation-category/web/components/category-chip-toolbar.tsx`
(toolbar trigger: `Badge as="button" colorClass={colorClass}`; popover option: same Badge,
`size="sm"`). The sidebar-row contribution uses the same Badge so all three category shapes
converge. Category color stays caller-provided via `colorClass`.

**LinkChip:**
- `…/active-data/plugins/conv/web/components/conv-chip.tsx`
- `…/active-data/plugins/task-link/web/components/task-link-chip.tsx`
- `…/active-data/plugins/attempt/web/components/attempt-chip.tsx`
- `…/active-data/plugins/plugin-link/web/components/plugin-link-chip.tsx` (leading icon, `gap-1`)
- `…/tool-call/plugins/add-task/web/components/add-task-tool-view.tsx` task link (drifted copy)
- `…/forge/plugins/catalog/web/components/plugin-chip.tsx` (mono; `className` for `bg-accent` override — verify it still reads as a link chip; if it clashes, leave as-is and note)

**Adjacent cleanup (not a Badge):** `…/deploy/plugins/servers/web/components/server-status-badge.tsx`
is a bare colored dot — migrate to the existing `StatusDot` primitive, not `Badge`.

## Out of scope → follow-up task

Create a task (per user request): **"Investigate unifying the remaining chip-like
*controls*"** covering the stats toggle chips (~8 sites in `plugins/stats/**`),
notification filter chips + filter group + bell unread count badge
(`plugins/notifications/web/components/bell-button.tsx`), and the prompt-template
split-button (`…/prompt-templates/web/components/prompt-template-chips.tsx`). These are
interactive segmented toggles / positioned indicators, a different concept that likely
wants a `ToggleChip` / segmented-control primitive rather than `Badge`.

## Files created

- `plugins/primitives/plugins/badge/web/{index.ts,internal/badge.tsx}` + `package.json`
- `plugins/primitives/plugins/link-chip/web/{index.ts,internal/link-chip.tsx}` + `package.json`

## Optional structural follow-up (recommended)

To prevent regression — per "fix the structural issue, not the instance" — contribute an
ESLint rule under `plugins/primitives/plugins/badge/lint/` that flags inline JSX with the
chip signature (`inline-flex` + `rounded*` + `px-`/`p-chip` + a bg/text color) on a bare
`span`/`div`, steering authors to `Badge`/`LinkChip` (mirrors
`tokens/plugins/typography/lint/no-arbitrary-font-size.ts`). Heuristic and potentially
noisy, so propose as a separate PR after the migration settles, not part of the core change.

## Verification

1. `./equin build` from the worktree; confirm the two new primitives appear in the
   generated registry and the app boots at `http://att-1780499219-s0eq.localhost:9000`.
2. `./equin check` — must pass `eslint`, `plugin-boundaries` (only
   `@plugins/primitives/plugins/{badge,link-chip}/web` imports cross-plugin), and
   `plugins-doc-in-sync` (CLAUDE.md autogen).
3. Visual before/after with `bun e2e/screenshot.mjs` on the high-density surfaces:
   - a conversation view (toolbar: status + model + category + summary-phase chips; sys
     badge in sidebar rows; allow-monitor pulse if present),
   - a task detail (status badge, attempts, queued chip),
   - the build detail pane (status pills + trigger label),
   - a plugin-view (runtime pills, load-bearing badge),
   - assistant text containing `conv-`/`task-`/`att-`/plugin-link chips (link-chip baseline
     alignment + hover underline).
   Confirm shapes are now consistent (one pill radius, one rounded radius) and no badge
   shifted size/baseline unexpectedly.
4. Grep that no in-scope file still hand-rolls chip markup:
   `rg -n "rounded(-full|-md|-sm)? .*px-.*py-.*text-(xs|3xs|2xs)" <in-scope dirs>` returns
   only the two primitives.
```

