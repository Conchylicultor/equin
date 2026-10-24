# Auto-displayed "configure" gear on config-backed pickers

## Context

When a list's options are defined by a `config_v2` descriptor (e.g. conversation
categories, preprompts, launch prompts), the UI *sometimes* shows a gear to jump
to that config and sometimes doesn't. The user noticed this inconsistency on the
**Preprompt** dropdown (no gear) vs. the **Conversation category** chip (gear).

Root cause: the gear (`ConfigGearButton` / `ConfigPopoverHeader` from
`@plugins/config_v2/plugins/config-link/web`) is a **manual add-on**, decoupled
from the act that creates the obligation — rendering a picker whose options come
from `useConfig(descriptor)`. Two surfaces reading the same kind of config
diverge because nothing ties the affordance to the consumption. The descriptor
already self-identifies its settings location (`useOpenConfig` keys off
descriptor reference identity via the `ConfigV2.WebRegister` registry), so the
gear needs no new registry — only a place to live that the author can't forget.

**Goal:** make the gear appear automatically wherever a config-backed picker is
rendered, generalizable across chrome types (not just one dropdown), and
*guaranteed* by a lint rule so a new config-backed picker can't ship without it.

### Audit — surfaces affected (from full repo sweep)

8 hand-authored `listField` descriptors; 10 consuming surfaces. Genuine pickers
that render an option list:

| Surface | Descriptor | Chrome | Gear today |
|---|---|---|---|
| `CategoryChipToolbar` | `conversationCategoryConfig` | InlinePopover | ✅ `ConfigPopoverHeader` |
| `FloatingTemplateChips` | `promptTemplatesConfig` | floating chips | ✅ `ConfigGearButton` |
| `PrepromptChip` | `prepromptsConfig` | info popover | ✅ `ConfigPopoverHeader` |
| **`PrepromptSelect`** | `prepromptsConfig` | `Select` dropdown | ❌ |
| **`LaunchPromptsButton`** | `launchPromptsConfig` | `DropdownMenu` | ❌ |
| **`ExcludedPathToggles`** | `commitsConfig` | inline toggle-chips | ❌ |

`PrepromptSelect` is rendered in **3 call-sites** (task-draft card, task detail,
launch popover) — fixing the component cures all three. Surfaces that read a
config list only to *classify/group* (code-review path warnings, section
grouping) render no option list and are out of scope. Auto-generated `reorder` /
`data-view` descriptor families are also out of scope (their editors are their
own surfaces).

## Approach

Two layers — **enablement** (a chrome that owns the gear) + **enforcement** (a
lint rule that requires the chrome). Clean split of responsibility:

- **`ui-kit`** owns *where a header goes* inside menu chrome — a generic,
  config-agnostic `header` slot. `ui-kit` sits at the bottom of the DAG and must
  not import `config_v2` (boundary inversion + import cycle), so it stays
  config-unaware.
- **`config-link`** owns *what the header is* — the gear. It already depends on
  `ui-kit`, `settings`, `icon-button`, `section-label`, so it's the natural home
  for config-aware picker chrome.

### 1. `ui-kit`: generic `header` slot on menu content containers

Add an optional `header?: React.ReactNode` to the two picker content containers.
Rendered inside the Popup, **above** the item list (so it is not a focusable
menu item — same structural position as the existing scroll buttons), sticky to
the top.

- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/select.tsx`
  — `SelectContent`: render `header` between `<SelectScrollUpButton/>` and
  `<SelectPrimitive.List>`, wrapped in a `sticky top-0 z-raised bg-popover` row.
  It sits outside `SelectPrimitive.List`, so base-ui never treats it as an item.
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/dropdown-menu.tsx`
  — `DropdownMenuContent`: render `header` as the first child of the Popup,
  above `{props.children}`. base-ui Menu only navigates `Item`s, so a header div
  is skipped by keyboard nav.

This is a config-agnostic primitive enhancement — any caller can pass a header.

### 2. `config-link`: config-aware picker wrappers

New components in `plugins/config_v2/plugins/config-link/web/components/`:

- `config-menu-header.tsx` — `ConfigMenuHeader({ label?, descriptor })`: a
  menu-styled row = optional `SectionLabel` + trailing `ConfigGearButton`
  (the menu twin of the existing `ConfigPopoverHeader`). Reuses
  `ConfigGearButton` unchanged.
- `config-select-content.tsx` — `ConfigSelectContent({ descriptor, label?, children, ...rest })`
  = `<SelectContent header={<ConfigMenuHeader .../>} {...rest}>{children}</SelectContent>`.
- `config-menu-content.tsx` — `ConfigMenuContent({ descriptor, label?, children, ...rest })`
  = `<DropdownMenuContent header={<ConfigMenuHeader .../>} {...rest}>{children}</DropdownMenuContent>`.

Export all three (+ types) from
`plugins/config_v2/plugins/config-link/web/index.ts`. The gear lives **inside**
the wrapper's chrome, so a picker built on `ConfigSelectContent` /
`ConfigMenuContent` literally cannot render without it.

Update `plugins/config_v2/plugins/config-link/CLAUDE.md` to document the two
wrappers as the sanctioned home for config-backed dropdown/menu pickers.

### 3. Migrate the 3 missing surfaces

- **`PrepromptSelect`** (`plugins/conversations/plugins/preprompts/web/components/preprompt-select.tsx`)
  — swap `SelectContent` → `ConfigSelectContent descriptor={prepromptsConfig} label="Preprompt"`.
  Item rendering (`PrepromptGlyph`, None option) unchanged. Fixes all 3
  call-sites at once. Add `config-link` to the plugin's web deps.
- **`LaunchPromptsButton`** (`plugins/conversations/plugins/conversation-view/plugins/launch-prompts/web/components/launch-prompts-button.tsx`)
  — swap `DropdownMenuContent` → `ConfigMenuContent descriptor={launchPromptsConfig} label="Launch prompts"`.
  Item rendering (model badges) unchanged.
- **`ExcludedPathToggles`** (`plugins/stats/plugins/commits/web/components/excluded-path-toggles.tsx`)
  — different chrome (inline toggle-chips, no menu container), so drop a plain
  `<ConfigGearButton descriptor={commitsConfig} />` at the end of the chip row
  (and in the empty-state, replace the "Add entries … in Settings" prose hint
  with the gear). No wrapper applies here — it's the explicit-placement case the
  wrappers exist to avoid, but the chrome genuinely has no menu header.

### 4. Enforcement: `no-unlinked-config-picker` lint rule

New lint sub-plugin
`plugins/config_v2/plugins/config-link/lint/` with `index.ts` (default-export
`{ name: "config-link", rules: { "no-unlinked-config-picker": rule } }`) and the
rule module. Discovered automatically by the root `eslint.config.ts` walk; runs
under the `eslint` / `type-check` checks. Rule file must be **self-contained**
(AST-only, no `@plugins/*` imports — jiti can't resolve them; see lint-rule
constraint).

**Rule contract (heuristic, low false-positive):** within a component function
that calls `useConfig(...)` (imported from `@plugins/config_v2/web`), flag any
JSX element `SelectContent` or `DropdownMenuContent` imported from the `ui-kit`
barrel. Message: steer to `ConfigSelectContent` / `ConfigMenuContent` from
`@plugins/config_v2/plugins/config-link/web` so the configure-gear is
guaranteed. Model the implementation on
`plugins/framework/plugins/tooling/plugins/lint/plugins/button-safety/lint/no-async-raw-button.ts`
(JSX-element visitor + import-source check; scope check for a `useConfig` call in
the enclosing function). Standard `// eslint-disable-next-line
config-link/no-unlinked-config-picker -- reason` escape hatch for a Select that
genuinely isn't config-backed.

> Optional precision upgrade (follow-up if false positives bite): bind the
> `useConfig(D)` result to the specific descriptor `D` and require that same `D`
> reach a `descriptor=` prop in scope, rather than the "any useConfig in scope"
> heuristic.

## Critical files

- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/select.tsx` — add `header` slot
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/dropdown-menu.tsx` — add `header` slot
- `plugins/config_v2/plugins/config-link/web/components/config-menu-header.tsx` — new
- `plugins/config_v2/plugins/config-link/web/components/config-select-content.tsx` — new
- `plugins/config_v2/plugins/config-link/web/components/config-menu-content.tsx` — new
- `plugins/config_v2/plugins/config-link/web/index.ts` — export wrappers
- `plugins/config_v2/plugins/config-link/lint/index.ts` + rule module — new
- `plugins/config_v2/plugins/config-link/CLAUDE.md` — document wrappers
- `plugins/conversations/plugins/preprompts/web/components/preprompt-select.tsx` — migrate
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/web/components/launch-prompts-button.tsx` — migrate
- `plugins/stats/plugins/commits/web/components/excluded-path-toggles.tsx` — migrate

## Reuse (don't reinvent)

- `ConfigGearButton`, `useOpenConfig` — existing, unchanged; wrappers compose them.
- `ConfigPopoverHeader` — existing popover twin; `ConfigMenuHeader` mirrors its shape.
- `SectionLabel` (`primitives/css/section-label`), `IconButton` (`primitives/icon-button`) — already config-link deps.
- `no-async-raw-button.ts` — template for the new lint rule (JSX visitor + import-source + scope checks).

## Verification

1. `./equin build` (regenerates registry/docs, runs checks incl. `eslint`,
   `type-check`, `plugins-doc-in-sync`, `plugin-boundaries`). Confirm the new
   `config-link/no-unlinked-config-picker` rule is picked up and the boundary
   checker accepts `config-link → ui-kit`.
2. Lint rule fires: temporarily revert `PrepromptSelect` to raw `SelectContent`
   and confirm `./equin check eslint` errors; then restore the wrapper and
   confirm it passes.
3. Manual UI check at `http://<worktree>.localhost:9000` with
   `bun e2e/screenshot.mjs`:
   - Open a conversation → **Preprompt** dropdown: gear now visible in the menu
     header; click it → routes to the preprompts config pane (`useOpenConfig`).
   - **Launch** dropdown (conversation prompt bar): gear in menu header → routes
     to launch-prompts config.
   - Task detail + launch-agent popover preprompt selects: gear present (same
     component).
   - Stats → Commits chart header: `ExcludedPathToggles` shows a gear → routes
     to commits config.
   - Regression: existing `CategoryChipToolbar` / `PrepromptChip` /
     `FloatingTemplateChips` gears still work.
4. Confirm no false positives: `./equin check eslint` stays green across
   the repo (no unrelated `Select` usage in a `useConfig` file trips the rule;
   if one does, add a justified `eslint-disable-next-line`).
