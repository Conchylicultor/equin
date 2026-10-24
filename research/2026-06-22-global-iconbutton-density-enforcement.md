# Close the two icon-button enforcement gaps (relocated density escape + IconButton steering)

## Context

`size` was removed from `Button`/`IconButton`: density (height) is now **purely ambient**
(`useControlSize()`, set by a region's `ControlSizeProvider`), and shape is the orthogonal
`aspect` prop (`"text"`|`"icon"`|`"inline"`). `IconButton` is the curated standalone-icon
path — it injects the mandatory `aria-label` + tooltip and renders a bare `<Icon/>`.

The call-site audit (`research/2026-06-22-global-iconbutton-misuse-audit.md`) migrated the
feature sites, but found two structural gaps that let the same per-instance divergence
reappear — nothing *prevents* the next one:

1. **The density escape just moved to `className`.** A fixed `h-N`/`size-N` class on a
   `<Button>` (any aspect) or `<IconButton>` re-introduces a per-instance height override
   (`className="size-6"` *is* the `xs` control height written by hand). It slips past both
   guards: the type lock (`size?: never`) only covers the `size` *prop*, and
   `no-adhoc-control` only fingerprints raw `<button>`/`<a>` host tags, never the `<Button>`
   component. Live escapes today: `broadcasts-panel`, `worktree-cleanup-panel`,
   `recovery-view`, `add-block-menu`, `secret-renderer` (text buttons, `h-6`/`h-7`), plus
   `edge-actions` and `row-action-button` (icon, `size-5`/`size-6`).
2. **Nothing steers a standalone `<Button aspect="icon"><MdX/></Button>` toward `IconButton`,**
   so authors hand-roll icon actions with no `aria-label` (the audit found exactly this).

`aspect="icon"` on `Button` **stays public** — it is the legitimate base square-geometry
primitive (trigger render-targets, text-glyph buttons, stateful-indicator children). The goal
is to close the divergence/misuse gap, not remove the prop.

Decision (confirmed): the height rule covers **all `Button` aspects + `IconButton`** — height
is ambient regardless of shape, so this is the true single-source fix, not just icon-scoped.

## Gap 1 — fixed-height class on `<Button>`/`<IconButton>` (extend `no-adhoc-control`)

Add a third check to the existing rule
`plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-control.ts` (it already
owns the density-single-source mission and already has the `collectTokens` walker + the
`FIXED_HEIGHT`/`FIXED_SIZE`/`baseClass` helpers — reuse them, no new shared code).

- **New `JSXAttribute` branch (Check C):** when the attribute is `className` and the parent
  opening-element tag is a **component** named `Button` or `IconButton`, harvest tokens via
  `collectTokens`; if any base-class matches `FIXED_HEIGHT` (`^h-\d`) or `FIXED_SIZE`
  (`^size-\d`), report a new `adhocControlSize` message: *"Height comes from ambient control
  density, not a per-instance class. Drop `h-*`/`size-*` and set density on the region via
  `<ControlSizeProvider size>` (or a slot's `controlSize`)."*
- Only digit-led `h-`/`size-` match, so `min-h-0`, `h-auto`, `h-full`, `w-N` stay legal
  (fixed *width* on a text button remains fine; only height is owned by the scale).
- Name-based tag match (`Button`/`IconButton`), consistent with the repo's other JSX lint
  rules. No auto-fix (region density choice is unsafe to mechanize).
- `lint/index.ts` `ignores` stays empty; genuine custom-chrome one-offs carry a per-site
  `// eslint-disable-next-line control-size/no-adhoc-control -- <reason>`, travelling with the code.

### Gap 1 migrations (so the build stays green)

Recipe mirrors the audit's proven Bucket-A pattern: wrap the action's container in
`<ControlSizeProvider size>` (import from `@plugins/primitives/plugins/css/plugins/ui-kit/web`),
drop the per-instance `h-*`/`size-*` and the ad-hoc `text-caption`/glyph `size-*` (Button
derives glyph + text from density). Map `h-7`→`sm`, `h-6`→`xs`.

| Site | Action |
|---|---|
| `plugins/debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` (h-7 ×3) | header action group + form-actions `Stack` → `ControlSizeProvider size="sm"` (header already wraps its IconButton in one — extend it to cover the `Add` button); drop `h-7` |
| `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` (h-7 ×4) | wrap the row action cell(s) + confirm-row action group → `size="sm"`; drop `h-7 text-caption` |
| `plugins/conversations/plugins/recover/web/components/recovery-view.tsx` (h-7) | wrap the row → `size="sm"`; drop `h-7 text-caption` |
| `plugins/page/plugins/editor/web/components/add-block-menu.tsx` (h-7) | wrap the `trigger` → `size="sm"`; drop `h-7 ... text-body` |
| `plugins/fields/plugins/secret/plugins/config/web/components/secret-renderer.tsx` (h-6) | wrap the action `Stack` → `size="xs"`; drop `h-6 ... text-caption` |
| `plugins/tasks/plugins/task-graph/web/components/edge-actions.tsx` (size-6 ×2, icon) | **keep bare** (custom circular graph-node chrome: `rounded-full border shadow-sm`) → `// eslint-disable-next-line control-size/no-adhoc-control -- custom-chrome graph-node action, intentional fixed 24px` |
| `plugins/conversations/.../jsonl-viewer/web/components/row-action-button.tsx` (size-5, icon) | sanctioned row-actions glyph leaf → eslint-disable with reason (already carries a layout disable) |

Note: lifting these text buttons to ambient `sm`/`xs` grows their labels from `text-caption`
to the density text rung — the intended correction per `control-size/CLAUDE.md`; verify each
region reads correctly (siblings in the same container share the new density).

## Gap 2 — steer standalone icon actions to `IconButton` (new rule)

New contributed rule `prefer-icon-button` co-located with the curated primitive:
`plugins/primitives/plugins/icon-button/lint/{index.ts,prefer-icon-button.ts}`
(default-export `{ name: "icon-button", rules: { "prefer-icon-button": … } }`; the root
`eslint.config.ts` auto-discovers it). No `@plugins`/shared imports (pure JSX-structure
inspection), so the jiti-cannot-resolve-alias constraint is avoided.

**Fires on a `<Button>` JSXElement when ALL hold:**
1. it has `aspect="icon"` (string literal), AND
2. its children — ignoring whitespace `JSXText` — are **exactly one** `JSXElement`, AND
3. that child's tag identifier resolves (via scope → import binding) to a module matching
   `^react-icons(/|$)` (the `IconButton.icon` contract), AND
4. the `<Button>` is **not** a render-target prop value — i.e. NOT
   `node.parent.type === "JSXExpressionContainer" && node.parent.parent.type === "JSXAttribute"`
   (skips `trigger={<Button…/>}` / `render={<Button…/>}`).

Report: *"A standalone icon action should use `<IconButton icon={…} label=… />` (it adds the
mandatory aria-label + tooltip). Keep a bare `<Button aspect=\"icon\">` only for triggers /
text-glyph / stateful children."* No auto-fix.

**Why this is precise (verified against every current `aspect="icon"` site):** exempt by
construction — `group-container` (child `<CollapsibleChevron/>`, not react-icons),
`edge-actions` (child `<Text>+</Text>`), `pane-icon-action` + `IconButton` itself (child is a
prop-bound `<Icon/>`, not a react-icons import), `exit-menu`/`sheet` (self-closing render
props), `new-child-task` + `dnd-list-middleware` (`trigger={…}` prop values),
`sidebar` `SidebarTrigger` (two children: icon + sr-only span).

### Gap 2 migration (the only currently-firing sites)

`plugins/primitives/plugins/launch/web/components/launch-control.tsx`:
- **line ~138** (per-model launch in the dropdown row): migrate to
  `<IconButton icon={MdPlayArrow} label={\`Launch ${…}\`} variant="ghost" className={hover-reveal} onClick=… />`;
  drop the glyph `size-3.5` (Bucket-A-style improvement — gains tooltip, keeps hover-reveal className).
- **line ~164** (default launch, glyph `className={MODEL_REGISTRY[…].iconSize}`): **keep bare** —
  `IconButton` hardcodes `<Icon/>` with no glyph className, so per-model glyph sizing can't be
  expressed. `// eslint-disable-next-line icon-button/prefer-icon-button -- per-model glyph size; IconButton hardcodes the glyph`.

## Files to modify

- `plugins/primitives/plugins/css/plugins/control-size/lint/no-adhoc-control.ts` — add Check C + `adhocControlSize` message.
- `plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md` — document the new check (hand-written "Enforcement" prose).
- `plugins/primitives/plugins/icon-button/lint/index.ts` + `lint/prefer-icon-button.ts` — new rule.
- `plugins/primitives/plugins/icon-button/CLAUDE.md` — document the new rule.
- The 6 Gap-1 migration files + 2 eslint-disable sites (table above).
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx` — Gap-2 migrate + disable.

## Verification

1. `./equin build` — runs codegen (regenerates the CLAUDE.md autogen blocks + lint
   discovery), then `type-check` (TS + type-aware ESLint, which now includes both new rules)
   and `eslint`. Must pass clean — confirms every flagged site is migrated or disabled.
2. **Rule fires as intended (negative test):** temporarily add `className="size-6"` to any
   `<IconButton>` and a bare `<Button aspect="icon"><MdRefresh/></Button>` in a scratch file;
   `bunx eslint <file>` reports `adhocControlSize` + `prefer-icon-button`; revert.
3. **No false positives:** confirm `./equin check eslint` (or the `type-check` lint pass)
   reports zero violations across the keep-bare set (`edge-actions`, `row-action-button`,
   `group-container`, `pane-icon-action`, `dnd-list-middleware`, `new-child-task`,
   `exit-menu`, `launch-control:164`, `sidebar`/`sheet`).
4. **Visual parity:** screenshot the migrated regions vs. current (expect box unchanged;
   labels/glyphs normalize to the region density rung — the intended correction). Use
   `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/... --out /tmp/...` for the
   broadcasts panel, worktree-cleanup table, secret field, add-block menu, recovery view, and
   the launch control dropdown. Confirm IconButton tooltips appear and `loading`/`disabled`
   still behave.