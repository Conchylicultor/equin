# Extract `ui-kit` primitive out of `web-core` (kill the ambient `@/` alias)

## Context

`web-core/web` currently mixes two unrelated jobs:

1. **SPA composition root** — `App.tsx`, `main.tsx`, `index.html`, the plugin
   loader, boot tasks, `plugin-load-errors.tsx`. This is genuine framework
   bootstrap and should stay.
2. **Foundational UI infrastructure** that isn't bootstrap at all:
   - `web/lib/utils.ts` — the `cn()` className-merge util (derives its
     `tailwind-merge` config from the custom-utility registry).
   - `web/components/ui/` — the 14 shadcn/ui primitives (+ `web/hooks/use-mobile.ts`).
   - `web/theme/` — `app.css` (the global stylesheet: token bridges, the `--z-*`
     ladder, every `@utility`, `@layer base`), `custom-utilities.ts` (the
     `CUSTOM_UTILITY_REGISTRY` single-source for `cn`), and `control-size.tsx`
     (the `ControlSize` React-context affordance-sizing mechanism).

This UI layer is reached app-wide through the **ambient `@/*` tsconfig/vite
alias** (`@/* → web-core/web/*`), which **completely bypasses the plugin-boundary
grammar** — the boundary checker's import regex only matches
`@plugins|@core|@server|@central`, so every `@/lib/utils`, `@/components/ui/*`,
`@/theme/*` import is invisible to the DAG enforcement. That makes `web-core` a
grab-bag and lets unrelated plugins reach into the framework layer untracked.

This was surfaced and explicitly deferred while building the affordance-sizing
mechanism (`research/2026-06-09-global-context-driven-affordance-sizing.md`),
which landed `theme/control-size.tsx` co-located here and noted it lives "in
web-core (the ambient ui-kit) … NOT in the `control-size` primitive." This task
finishes the decoupling.

**Outcome:** a dedicated `primitives/ui-kit` plugin owns `cn`, the shadcn
components, and the theme. Every consumer imports the boundary-legal barrel
`@plugins/primitives/plugins/ui-kit/web`. The `@/*` alias is deleted entirely, so
any stray `@/` import now fails loudly at TypeScript + Vite build time (no guard
needed). `web-core` shrinks to just the SPA composition root.

## Decisions (confirmed with user)

- **Single `ui-kit` plugin** (not an umbrella of sub-plugins). `cn`, shadcn, and
  theme are one cohesive design-system unit: `cn` depends on `custom-utilities`,
  shadcn depends on `cn`, and the shadcn CLI assumes one root with
  lib+ui+hooks+css co-located. Splitting them adds cross-plugin barrels between
  things that are inherently coupled and breaks the CLI workflow.
- **Fully remove `@/*`** — rewrite all importers to the barrel and repoint the
  shadcn `components.json` aliases so the CLI keeps working. This is the whole
  point: make the dependencies visible to the boundary checker.
- **No regression guard** — deleting the alias means a stray `@/` import is an
  unresolved-module error at build time. Loud failure; nothing extra to enforce.

## Target structure

```
plugins/primitives/plugins/ui-kit/
  CLAUDE.md                 # new (hand prose + autogen block)
  package.json              # new: @singularity/plugin-primitives-ui-kit + moved UI runtime deps
  components.json           # moved from web-core; css path + aliases repointed
  web/
    index.ts                # NEW barrel — re-exports cn, all shadcn symbols, control-size API
    lib/utils.ts            # moved (cn)            + utils.test.ts
    components/ui/*          # moved (14 shadcn files)
    hooks/use-mobile.ts     # moved
    theme/
      app.css               # moved — still the Tailwind entry, imported by web-core main.tsx
      custom-utilities.ts   # moved (internal; not re-exported)
      control-size.tsx      # moved (ControlSize context — re-exported via barrel)
      CLAUDE.md             # moved
```

`web-core/web` keeps only: `App.tsx`, `main.tsx`, `index.html`, `vite-env.d.ts`,
`components/plugin-load-errors.tsx`, `__tests__/`, `public/`.

The barrel `web/index.ts` re-exports (plugin-own internal files only — barrel-pure):
- `cn` from `./lib/utils`
- every public symbol of the 14 shadcn components from `./components/ui/*`
  (`Button`/`buttonVariants`/`ButtonProps`, `Dialog*`, `Popover*`, `Tooltip*`
  incl. `TooltipProvider`, `DropdownMenu*`, `Select*`, `Sheet*`, `ScrollArea*`,
  `Separator`, `Skeleton`, `Input`, `ButtonGroup`, `Resizable*`, `Sidebar*`, …)
- `ControlSize`, `ButtonIconSize`, `ControlSizeProvider`, `useControlSize`,
  `iconSizeFor`, `textSizeFor` from `./theme/control-size`
- `default { description, contributions: [] } satisfies PluginDefinition`

## Migration scope (post-rebase counts)

| Old specifier | Files | New specifier |
|---|---|---|
| `@/lib/utils` (`cn`) | 127 | `@plugins/primitives/plugins/ui-kit/web` |
| `@/components/ui/*` | 110 | `@plugins/primitives/plugins/ui-kit/web` |
| `@/theme/control-size` (external) | 4 | `@plugins/primitives/plugins/ui-kit/web` |
| `@/hooks/use-mobile` | 1 (internal, moves) | relative inside ui-kit |

The 4 external `control-size` importers: `primitives/{icon-button, toggle-chip,
pane, slot-render}`. Many files import both `cn` and a component — the codemod
must **merge** same-module imports (avoid duplicate-import lint errors).

## Implementation steps

1. **Scaffold + move.** Create `plugins/primitives/plugins/ui-kit/`; `git mv`
   `lib/`, `components/ui/`, `hooks/`, `theme/` and `components.json` from
   `web-core/web` into `ui-kit/web` (components.json to the plugin root). Add
   `package.json` (move the UI runtime deps from web-core: `clsx`,
   `tailwind-merge`, `class-variance-authority`, `radix-ui`, `@base-ui/react`,
   `react-resizable-panels`, `@fontsource-variable/*`; web-core keeps the Vite /
   Tailwind / shadcn *build* devDeps since it remains the build root).
2. **Internal imports of moved files.** Rewrite the shadcn files' `@/lib/utils`,
   `@/theme/control-size`, `@/hooks/use-mobile` and `utils.ts`'s
   `@/theme/custom-utilities` to the deep `@plugins/primitives/plugins/ui-kit/web/...`
   self-paths (same-plugin → boundary-legal; matches the repointed
   `components.json` aliases so the shadcn CLI reproduces them drift-free).
3. **Barrel.** Author `ui-kit/web/index.ts` (enumerate every exported symbol of
   the 14 shadcn files + control-size + `cn`).
4. **CSS entry.** In `web-core/web/main.tsx` change `import "./theme/app.css"` →
   `import "@plugins/primitives/plugins/ui-kit/web/theme/app.css"`. Fix the
   `@source` relative path inside `app.css` for its new depth (was
   `../../../../../../plugins/`; from `primitives/plugins/ui-kit/web/theme/` →
   `../../../../../plugins/` — verify by build).
5. **Delete `@/*`** from all four configs: root `tsconfig.json`,
   `web-core/tsconfig.json`, `web-core/tsconfig.app.json`,
   `web-core/vite.config.ts`. (tsconfig `include` already covers the new plugin
   via `**/plugins/*/web`; no include change needed.)
6. **`components.json`.** Update `tailwind.css` → ui-kit `web/theme/app.css` and
   repoint `aliases.{components,utils,ui,lib,hooks}` to the
   `@plugins/primitives/plugins/ui-kit/web/...` paths.
7. **Codemod external importers** (steps' bulk, ~240 sites): a Bun/TS,
   import-aware codemod rewriting the four old specifiers to the single barrel
   and merging same-module import declarations (preserve `type` modifiers).
8. **Fix the one R3 re-export leak.** `primitives/tooltip/web/index.ts` currently
   re-exports `TooltipProvider` from shadcn — illegal cross-plugin re-export once
   visible. Remove that line; update its one consumer
   `plugins/apps/web/components/apps-layout.tsx` (and the web-core test) to import
   `TooltipProvider` from the ui-kit barrel directly. Tooltip keeps owning
   `WithTooltip` + `Kbd`.
9. **Update the one check with hardcoded paths.**
   `…/checks/plugins/app-css-utilities-in-sync/check/index.ts` `APP_CSS` /
   `CUSTOM_UTILITIES` constants (+ hint text) → ui-kit theme paths.
   (`css-vars-single-owner` / `css-vars-supplied` discover CSS via
   `git ls-files plugins/**/*.css` — no change.)
10. **Docs/cosmetics.** Move `theme/CLAUDE.md` with the folder; rewrite
    `web-core/CLAUDE.md` to describe a pure composition root; add `ui-kit/CLAUDE.md`;
    fix the two stale `web-core/web/theme/app.css` path mentions in
    `primitives/z-layers/lint/no-adhoc-zindex.ts` (cosmetic). The autogen doc
    blocks + `web.generated.ts` + `plugins-*.md` regenerate via build.
11. **Build + regenerate.** `./equin build` (regenerates the web registry
    to include ui-kit, plugin docs, token-group vars). Then `./equin check`.

## Reuse / precedent

- Mirror an existing presentational primitive barrel byte-for-byte
  (`primitives/badge/web/index.ts`, `primitives/text/web/index.ts`): re-export
  internal files + a single `default … satisfies PluginDefinition`.
- Registry is auto-discovered — any `web/index.ts` is picked up by
  `web.generated.ts` on build. No manual registry edit.
- Per-plugin CSS convention already exists; `app.css` remains the single global
  stylesheet (the project intentionally has **no** CSS-aggregation mechanism —
  one global entry + Tailwind `@source` scan of `plugins/`).

## Verification

1. `./equin build` succeeds (frontend + server) — proves the Vite `@/`
   removal, the moved `app.css`/`@source`, and the barrel all resolve.
2. `./equin check` passes — especially `plugin-boundaries` (the new ui-kit
   edges are now tracked and must form a DAG; the tooltip re-export must be
   gone), `app-css-utilities-in-sync`, `css-vars-single-owner`,
   `eslint` (no duplicate imports, no stray `@/`), and `plugins-doc-in-sync`.
3. `rg -n '@/lib/utils|@/components/ui|@/theme|@/hooks' -g '*.ts' -g '*.tsx'`
   returns **zero** source hits.
4. Visual smoke via Playwright on `http://<worktree>.localhost:9000` — load the
   agent-manager and a couple apps (Tasks, Studio); confirm buttons, popovers,
   tooltips, control sizing, and theming render identically (this exercises
   `cn`, shadcn, `control-size`, and `app.css`).
5. `bun run test` (web-core vitest) — the moved `utils.test.ts` and
   `plugin-render.test.tsx` pass.

## Risks / notes

- **Atomic change.** The move + alias-deletion + codemod can't land half-done;
  the build is red until all import sites are rewritten. Do it in one pass, then
  build.
- **Barrel completeness.** The barrel must export *every* symbol the 110 shadcn
  importers use — a missing re-export is a compile error caught by the build.
- **shadcn CLI.** After this, `components.json` lives in the ui-kit plugin with
  `@plugins/...` aliases; future `shadcn add` runs from there.
- **Load-bearing.** This touches framework config (4 alias definitions) and a
  built-in check path, but does **not** modify the boundary checker/lint engine
  itself — no change to load-bearing enforcement logic.
