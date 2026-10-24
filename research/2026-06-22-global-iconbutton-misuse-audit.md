# Audit: bare `<Button aspect="icon">` feature sites — IconButton misuse + relocated density escapes

## Context

The `size` prop was already removed from `Button` (commits `68bbeff0c` "derive size from
ambient ControlSize; aspect prop owns shape" and `626887171` "remove size prop" for
IconButton). Density is now purely ambient (`useControlSize()` set by a region's
`ControlSizeProvider`); shape is the orthogonal `aspect` prop (`"text"` | `"icon"` |
`"inline"`). `IconButton` and `PaneIconAction` pass `aspect="icon"` and type-lock `size`
out via `Omit<…, "size">`. All seven feature sites the original task named were already
migrated to `aspect="icon"`.

This follow-up audits the **~16 bare `<Button aspect="icon">` feature call sites** to
answer: which are really `IconButton` misuse, and what should each become?

### Key finding — the escape just moved to `className`

Default density tokens (Comfortable preset, `layout-harness/.../entry.html`):

| Tailwind | px | `--control-height` step |
|---|---|---|
| `size-6` | 24px | **xs** (1.5rem) |
| `size-7` | 28px | **sm** (1.75rem) |
| `size-8` | 32px | md (2rem, default) |

Most bare sites carry `className="size-6"` (or `size-7`) on the Button **and** a
`size-3`/`size-3.5` on the glyph. `size-6`/`size-7` are not arbitrary — they are the `xs`/`sm`
control heights written by hand. So these sites are requesting a non-default density via
raw Tailwind, which slips past **both** guards: the type lock (it's `className`, not a
`size` prop) and `no-adhoc-control` (an icon-only button with just `size-6` has no
height+px+rounded triad). This is the same per-instance divergence the `size` removal
killed, relocated. The right fix mirrors commit `626887171`: lift density to the region
via `ControlSizeProvider`, drop the per-instance `size-*`, and let `IconButton` derive
both box and glyph.

`IconButton` contract (for eligibility): `icon: ComponentType<{className?}>` rendered as a
bare `<Icon />` (no glyph className forwarded), `label` → aria-label + tooltip, always
wraps `WithTooltip`, forwards `variant`/`className`/`onClick`/`disabled`/`loading`/`aria-*`
via `{...props}`.

## Decision rule

**Migrate to `IconButton`** when the single child is a plain icon component and the button
is a standalone action. **Keep bare `<Button aspect="icon">`** when:
- the child is **not** a plain icon (`<Text>+</Text>`, a stateful `CollapsibleChevron`), or
- the Button is a **render-target/trigger** for another component
  (`DropdownMenuTrigger render={…}`, popover trigger) — IconButton's tooltip wrapper +
  injected `<Icon/>` child conflict with receiving children/ref from the trigger. The
  established pattern for "icon button that opens a popover" is a bare Button with the
  tooltip supplied at the popover level (see `dnd-list-middleware`).

## Bucket A — migrate to `IconButton` (10 sites)

For each: `<Button variant=… aspect="icon" …><MdX className=…/></Button>` →
`<IconButton icon={MdX} label="…" … />`. Drop the glyph `size-*` (IconButton derives it).
Map a Button `size-6`→region `xs`, `size-7`→region `sm` (see per-site density action).

| # | File | Action |
|---|---|---|
| 1–2 | `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` (2×, "Copy logs", `size-6`) | IconButton; wrap each header strip (`<div flex items-center justify-between>`) in `<ControlSizeProvider size="xs">`, drop `size-6` |
| 3 | `plugins/build/web/components/build-button.tsx` ("Open in pane", `size-6`, glyph `size-3`) | IconButton; header → `ControlSizeProvider size="xs"`, drop `size-6` + glyph size |
| 4 | `plugins/build/web/components/build-popover-content.tsx` ("Copy logs", `size-6`, `disabled`) | IconButton; header → `xs`, drop `size-6` |
| 5 | `plugins/debug/plugins/broadcasts/web/components/broadcasts-panel.tsx:117` ("Refresh", `size-7`, only `title`) | IconButton(label="Refresh"); the strip already holds an `h-7` (sm) text button → wrap strip in `ControlSizeProvider size="sm"`, drop `size-7` + glyph; gains a real aria-label |
| 6 | `plugins/debug/plugins/broadcasts/web/components/broadcasts-panel.tsx:277` ("Delete", `size-6`, `loading`, hover-destructive className) | IconButton(label="Delete", loading, className for hover color); list-row region → `xs`, drop `size-6` + glyph |
| 7 | `plugins/debug/plugins/memory/web/components/memory-panel.tsx` ("Refresh", `size-6`) | IconButton(label="Refresh"); header → `xs`, drop `size-6` + glyph |
| 8 | `plugins/tasks/plugins/task-description/web/components/description-view.tsx` ("Edit description", `size-6`, glyph `size-3.5`, inside `<Pin>` + `hoverRevealTarget`) | IconButton(label="Edit description", className=`hoverRevealTarget`); region → `xs`, drop `size-6` + glyph |
| 9 | `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx:231` (refresh, `variant="outline"`, `loading`, **no label**) | IconButton(icon=MdRefresh, label="Refresh", variant="outline", loading). No size class → ambient `md` stays; pure a11y win (adds label+tooltip) |
| 10 | `plugins/conversations/.../notes/web/components/notes-toggle-button.tsx` (toggle, `secondary`/`ghost`, `aria-pressed`, glyph `size-3.5`) | IconButton(icon=MdStickyNote2, label/tooltip dynamic, variant, `aria-pressed` via props). No size class → ambient stays; drop glyph size |
| 11 | `plugins/conversations/.../resume/web/components/resume-button.tsx` (`outline`, `loading`, `disabled`, dynamic title, glyph `size-3.5`) | IconButton(icon=MdReplay, label="Resume", tooltip={dynamic}, variant="outline", loading, disabled). No size class → ambient stays; drop glyph size |

(Rows 1–8 lift density to the region; rows 9–11 already rely on ambient density and only
need the Button→IconButton swap + glyph-size drop.)

Note on rows 1–8: if a header strip contains *only* the icon button plus a `<Text>` label,
the region `ControlSizeProvider` affects just that button — safe. Where a sibling control
exists (broadcasts:117 has an `h-7` text button), the region density makes both consistent;
verify the sibling still reads correctly (its hardcoded `h-7` can later also drop to ambient).

## Bucket B — keep bare `<Button aspect="icon">` (5 sites)

| File | Why it stays bare |
|---|---|
| `plugins/tasks/plugins/task-graph/web/components/edge-actions.tsx` (2×) | Children are text glyphs `<Text variant="label">+</Text>` / `×`, not icon components; heavy custom chrome (`size-6 rounded-full border shadow-sm`). Not an `IconButton`. |
| `plugins/conversations/.../grouped/web/components/group-container.tsx` | Child is a stateful `<CollapsibleChevron open={…}/>`, not `ComponentType<{className}>`. |
| `plugins/conversations/.../exit-menu/web/components/exit-menu-button.tsx` | Button is `DropdownMenuTrigger render={…}`; the glyph (MdLogout) is the trigger's child. Tooltip wrapper + injected child conflict. |
| `plugins/reorder/web/internal/dnd-list-middleware.tsx` | Popover trigger with `onPointerDown` stopPropagation + `pointer-events-auto` for nested reorder; tooltip already supplied at the popover level. |
| `plugins/conversations/.../new-child-task/web/components/new-child-task-action.tsx` | `trigger={…}` of `TaskDraftPopover`; keep consistent with the bare-trigger pattern (popover owns the tooltip). |

These five justify `Button` keeping a **public `aspect="icon"`** — it is a legitimate base
primitive, not special-cased out. The enforcement story stands: `size` removal is
type-level; `IconButton` is the curated path for the common standalone-icon case.

Also untouched (not feature code): `row-action-button.tsx` already wraps `<Button aspect="icon">`
as the `row-actions` primitive's glyph leaf (`size-5`, rigid) — that's a sanctioned primitive,
leave as-is.

## Structural follow-up (report, don't patch around)

The raw-`className="size-6"` density escape slips past `no-adhoc-control` and the type lock.
Recommend (separate task, not blocking): extend `no-adhoc-control`
(`plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-control.ts`) to flag a
fixed height/`size-N` class on a `<Button aspect="icon">` (and on `IconButton`), pointing
authors at a region `ControlSizeProvider` instead. This eliminates the class of escape at
the source rather than per-site. Surface via `add_task`.

## Critical files

- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` — target component (no edits expected)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx` — `ControlSizeProvider`
- The 10 Bucket-A files above (edits)
- Each region's import of `ControlSizeProvider` from `@plugins/primitives/plugins/css/plugins/ui-kit/web`

## Verification

1. `./equin build` (type-check confirms IconButton props; `no-adhoc-control` + `type-check` run).
2. Screenshot each migrated region against current to confirm box + glyph size unchanged
   (glyph normalizes to the density default — expect a 14px→16px change only where a `size-3`/`size-3.5`
   override was dropped; confirm acceptable):
   - build popover header, build pane log sections, broadcasts panel (refresh + delete),
     memory panel header, task description edit affordance, worktree-cleanup refresh,
     notes toggle, resume button.
   Use `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/... --out /tmp/...`.
3. Confirm tooltips appear on the migrated buttons (IconButton wraps `WithTooltip`), and that
   `aria-pressed` (notes toggle), `loading` (resume, broadcasts delete, worktree refresh), and
   `disabled` (resume, build copy) still behave.
4. Bucket-B sites: confirm no behavioral change (untouched).
