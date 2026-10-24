# Context-Driven Control Size (toolbar-enforced density)

> Status: PLAN. Sibling of the landed `icon-auto` work
> ([2026-06-09-global-context-driven-affordance-sizing.md](./2026-06-09-global-context-driven-affordance-sizing.md)),
> one level up: that one made *glyphs* track surrounding font-size via CSS cascade;
> this one makes *controls* (height/density bundle) track a toolbar-declared density
> via React context.

## Context

Buttons in the same toolbar render at different sizes. Concretely, in the
conversation toolbar the **launch-app** icon and the **terminal** icon differ:

- Launch app — `open-app-button.tsx` → `PaneIconAction` → `IconButton` →
  `<Button size="icon">` = `control-icon-md`.
- Terminal — `terminal-button.tsx:6` → raw `<Button size="sm">` = `control-sm`.

This is not a typo — it is a **missing abstraction**. Every toolbar host is a bare
flex row that renders contributions as opaque, zero-prop components
(`{ component: ComponentType }`), so there is no props channel to push a size down.
Size is therefore necessarily declared per-button, and buttons disagree. "The
toolbar enforces a consistent size" is impossible by construction today.

**Outcome wanted:** a toolbar declares one **density** (`xs|sm|md|lg`); every item
— text button, icon button, chip — inherits it and snaps to the same height while
keeping its own shape. Items stop declaring size. An explicit `size` remains a
legal escape hatch outside toolbars (forms/dialogs).

**Decisions locked with the user:**
- Enforcement = **slot provides + escape hatch** (no global `size` ban; the
  size-owning slot auto-wraps children in the density context, items omit `size`).
- Conversation + shell toolbar density = **`sm` (compact)** — the launch icon
  shrinks to match the terminal button.
- Density carried by context is a pure `ControlSize = "xs"|"sm"|"md"|"lg"`; each
  control maps it to *its own* shape bundle (text → `control-sm`, icon →
  `control-icon-sm`, chip → its `sm`). This is why a single CSS height var is
  insufficient — the size is a named bundle (height + padding + radius + text +
  gap + icon), so the context carries the density *name* and each control resolves
  its bundle.

## Layering decision

`slot-render` is a `primitives/` plugin **below** web-core (web-core → primitives,
never the reverse). Button (web-core) must *read* the density context; the
size-owning slot (`slot-render`) must *provide* it. A context in web-core is
unreachable by slot-render. Therefore the context's home is the **`control-size`
primitive** — today it holds only the lint rule + the CSS `control-*` scale; giving
it a tiny `web/` runtime makes it the runtime single-source-of-truth too.

- web-core `button.tsx` imports `useControlSize` + mappers from
  `@plugins/primitives/plugins/control-size/web` (web-core → primitive ✓, already
  the direction for error-boundary/live-state/text).
- `slot-render` imports `ControlSizeProvider` from the same barrel (primitive →
  primitive, DAG-safe: control-size/web depends only on `react`).

The canonical `ControlSize` type **moves** to the control-size primitive; `button.tsx`
re-exports it (`export type { ControlSize }`) so the ~123 existing
`@/components/ui/button` importers are unaffected.

## Design

### 1. New web runtime — `plugins/primitives/plugins/control-size/web/`

`internal/control-size.tsx`:
- `export type ControlSize = "xs" | "sm" | "md" | "lg"` (canonical home).
- `ControlSizeContext` — React context, default `"md"`.
- `<ControlSizeProvider size>` — provides density to subtree.
- `useControlSize(): ControlSize` — reads it.
- Density → cva-token mappers (control-size owns the density→token mapping):
  - `iconSizeFor(d)` → `"icon-xs" | "icon-sm" | "icon" | "icon-lg"` (`md`→`"icon"`).
  - `textSizeFor(d)` → `"xs" | "sm" | "md" | "lg"`.

`web/index.ts` — barrel mirroring `icon-button`'s shape: re-export the public
symbols, end with `export default { description, contributions: [] } satisfies
PluginDefinition`. Register in `web/src/plugins.ts` if discovery requires it
(mirror how icon-button/badge are handled).

### 2. `web-core` Button — inherit density when `size` omitted

`plugins/framework/plugins/web-core/web/components/ui/button.tsx`
- `size` prop becomes optional with **no default**.
- When `size === undefined`: `size = textSizeFor(useControlSize())`. When provided:
  use it verbatim (escape hatch).
- Import `useControlSize`, `textSizeFor`, `ControlSize` from
  `@plugins/primitives/plugins/control-size/web`; re-export `ControlSize` for
  back-compat. Keep the cva `size` variants as-is.

> Bare `<Button>` resolves to the *text* variant of the context density. Icon
> shape is the wrapper's job (below) — Button alone can't know its shape.

### 3. `IconButton` + `PaneIconAction` — icon variant from context

- `icon-button.tsx`: drop the hardcoded `size = "icon"` default. When `size`
  omitted: `size = iconSizeFor(useControlSize())`. Explicit `size` still wins.
- `pane-icon-action.tsx`: currently hardcodes `size="icon"` on both branches and
  exposes no `size` prop. Remove the hardcode so it inherits (the `IconButton`
  branch inherits automatically; the `children`+`Button` branch passes
  `size={iconSizeFor(useControlSize())}`). No new prop needed — toolbar items want
  inheritance.

### 4. `ToggleChip` — density from context

`plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` currently
takes a local `size?: "sm"|"md"` (default `"md"`) mapping to `control-xs`/`control-sm`.
- When `size` omitted, derive from `useControlSize()`. Map the 4-level density onto
  the chip's 2-level scale: `xs|sm → "sm"`, `md|lg → "md"` (documented clamp), or
  extend the chip to all four `control-*` if cheap. Explicit `size` still wins.

### 5. `slot-render` — size-owning slots auto-provide the context

`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`
- Extend `RenderSlotConfig<P>` (line 26) with `controlSize?: ControlSize`.
- In `.Render`, capture `const controlSize = config?.controlSize`. After the
  reorder list-middleware wrap and before `withSentinel` (~line 183), if
  `controlSize` is set, wrap `result` once in
  `<ControlSizeProvider size={controlSize}>...</ControlSizeProvider>`.
- Import `ControlSizeProvider` + `ControlSize` from
  `@plugins/primitives/plugins/control-size/web`.

> One provider per slot (not per item) — declaring `controlSize` on the slot **is**
> the act of enforcing it; no host can forget. A host may still wrap in its own
> `ControlSizeProvider` to override (innermost context wins).

### 6. Retrofit the toolbar hosts

- `conversation.action-bar` slot (`.../action-bar/web/slots.ts`) →
  `defineRenderSlot(..., { controlSize: "sm" })`.
- `action-bar.item` slot (`plugins/shell/plugins/action-bar/web/slots.ts`) →
  `{ controlSize: "sm" }`. (Shell action-bar strip **and** floating-bar render this
  same slot, so both inherit `sm` consistently — desired.)
- PaneChrome actions use bare `defineSlot` + `renderIsolated`, not
  `defineRenderSlot`, so the slot-config path doesn't reach them. Wrap the actions
  row in `pane-chrome.tsx` (~line 123) manually in `<ControlSizeProvider size="sm">`.

### 7. Drop now-redundant per-item sizes (the actual bug fix)

- `terminal-button.tsx`: replace raw `<Button variant size="sm">` with
  `IconButton` (icon=`MdTerminal`, label="Terminal", `variant`/`aria-pressed`/
  `onClick` preserved) — no `size`. It now inherits the toolbar's `sm`.
- Sweep other `conversation.action-bar` / `action-bar.item` contributions that pass
  an explicit `size`/`size-N` and drop it so they inherit. Grep:
  `rg -n "size=\"(icon|sm|xs|md|lg)\"" plugins/conversations/plugins/conversation-view/plugins/*/web plugins/**/web | grep -i action` and eyeball each toolbar contributor.

### 8. Docs

- **theme skill** (`.claude/skills/theme/SKILL.md`) — add a short mental-model block
  (see exact copy below) under the "Design-standard enforcement" area, and update
  the Control-size bullet to mention the context.
- `control-size/CLAUDE.md` — document the runtime context, `ControlSizeProvider`,
  `useControlSize`, the density→bundle mapping, and the "toolbars declare density;
  items inherit; `size` is an escape hatch" rule.
- Autogen docs (`plugins-compact`/`plugins-details`) regenerate on build.

## Theme-skill mental model (exact insert, non-verbose)

```md
## Control size = density inherited from context
A control's size is a **bundle** (height + padding + radius + text + gap + icon),
named by a density `ControlSize = xs|sm|md|lg`. Don't size buttons individually.
- A **toolbar/slot declares density once** (`defineRenderSlot(id, { controlSize })`
  or wrap in `<ControlSizeProvider size>`); every item inherits via React context.
- Each control maps that density to **its own shape**: text→`control-sm`,
  icon→`control-icon-sm`, chip→its `sm`. Same height, different shapes.
- Items **omit `size`** to inherit. An explicit `size` is an escape hatch — fine
  for standalone controls (forms/dialogs), wrong inside a toolbar.
- Runtime home: the `control-size` primitive (`ControlSizeProvider`,
  `useControlSize`); the CSS `control-*` scale + `no-adhoc-control` lint live there too.
→ plugins/primitives/plugins/control-size/CLAUDE.md
```

## Critical files

- `plugins/primitives/plugins/control-size/web/` (**new** runtime: context, provider, hook, mappers, barrel)
- `plugins/framework/plugins/web-core/web/components/ui/button.tsx` (inherit + re-export type)
- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`
- `plugins/primitives/plugins/pane/web/components/pane-icon-action.tsx`
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` (wrap actions row)
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx`
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` (config + wrap)
- `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/slots.ts`
- `plugins/shell/plugins/action-bar/web/slots.ts`
- `plugins/conversations/plugins/conversation-view/plugins/terminal-pane/web/components/terminal-button.tsx`
- `.claude/skills/theme/SKILL.md`, `plugins/primitives/plugins/control-size/CLAUDE.md`

## Verification

1. `./equin build` — tsc + vite pass; new control-size barrel discovered;
   `plugins-doc-in-sync` / registry codegen regenerate (commit generated files).
2. `./equin check` — boundaries (no new cycle: control-size/web → react only;
   web-core → control-size; slot-render → control-size), eslint (`no-adhoc-control`
   still green), plugins-doc-in-sync.
3. **Playwright** on a conversation toolbar
   (`bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/c/<id>`): measure the
   bounding-box heights of the launch-app and terminal buttons — expect **equal**
   heights (both `--control-height-sm`), launch icon shrunk from md→sm.
4. Spot-check the shell action bar + floating bar (same slot) render at `sm` and a
   text button inside a toolbar matches the icon buttons' height.
5. Eyeball a standalone `<Button size="...">` in a form is unaffected (escape hatch).

## Risks

- **R1:** Button `size` losing its hard default means any `<Button>` *not* under a
  provider falls back to context default `"md"` = today's `default`. Net zero for
  existing standalone buttons. Verify no call site relied on `size` being literally
  `"default"` string.
- **R2:** `ToggleChip` density clamp (4→2 levels) is lossy for `xs`/`lg` contexts;
  documented. Extend to 4 levels if a toolbar needs it.
- **R3:** Enforcement is convention-backed, not lint-enforced (static lint can't see
  slot membership). Accepted per decision; the size-owning slot auto-providing the
  context is the structural half that prevents the reported class of bug.
- **R4:** control-size gaining a `web/` runtime — confirm a primitive with a default
  `PluginDefinition` export and `contributions: []` doesn't need explicit registry
  wiring beyond mirroring icon-button/badge.
