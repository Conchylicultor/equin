# A plugin scope is served by its own hosts

Task: att-1794327839 (supervisor track page block-d04c6c0d…). Fixes, once verified:
task-1794322463-o1d3y4 (theme), task-1794322469-11ceda (Sonata icon family),
task-1794322475-3hq260 (first-time tips).

## Context

`<PluginScope>` (web-sdk) narrows every slot READ in its subtree to its
composition. But some features are not read in the subtree: a page-root host
(a `Core.Root` contribution) collects a slot's contributions once, at the page
root, through the PAGE's reader, and applies them page-globally (CSS in
`<head>`, a module store, a portal stage). Two consequences:

- **Standalone website** (demo plugins on demand, `excludingReader` hides them
  from the page): those hosts never see the demo's contributions. Sonata's
  chord/file/place token groups are never painted; Sonata's `Icons.Family` is
  never published (blank glyphs); `Hints.Hint` declared by on-demand plugins is
  never seen and the hints host itself may be on demand (no tips); the
  `HostInputs.Supply` of google-maps is not seen by `DemoScope` (no Maps key).
  And what the hosts DO paint is the page's: the website's `:root` theme
  (`equin`: type scale, blue buttons) is inherited by the whole demo.
- **Main's /demo**: every plugin is the page's own, so the same page hosts cover
  the demo's plugins by accident, with the PAGE's config/transport. /demo shows
  something the site's visitors never get, so its 15 e2e scripts and reviewers
  on main are blind to the site's bugs.

Main cannot load a second copy of the demo's plugins: they are main's own apps,
the browser holds one module instance per specifier, and the register phase is
page-global (explorer finding). So parity cannot come from "load them again"; it
must come from an invariant that makes what the page holds irrelevant inside a
scope.

## The rule

**A scope is served by its own hosts; the page's hosts never serve inside a
scope.**

1. Every `Core.Root` contribution declares `scope: "page" | "each"` —
   required (tsc). `"page"`: page chrome, mounted once at the page root
   (unchanged). `"each"`: a host of the plugins it reads — mounted at the page
   root AND again inside every `<PluginScope>`, reading that scope's
   contributions, its transport and its `usePluginScopeId()`.
2. A `"each"` host keeps its output scope-local: anything it writes into a
   page-global place (a CSS selector, a module store, a portal stage) is keyed
   by `usePluginScopeId()`, so the page's instance cannot match, fill or draw
   inside a scope and the scope's cannot leak onto the page.
3. `PluginScope` mounts them: web-sdk cannot import slot-render, so the page
   root hands its root renderer to `PluginProvider` (`scopeRoots`), and every
   `PluginScope` renders it with `where: "each"` inside its own providers.
   `PluginProvider` with `plugins` (tests) defaults to none.

With (1)–(3), on main and on the site the scope's reader holds exactly
`browserHost.plugins` and the scope's hosts are the only ones serving it: the
demo looks the same on both by construction. Nothing on the page reaches in
except `pageWide` slots, which are reviewed below.

## Per host

| Host | Scope | What changes |
|---|---|---|
| theme-engine `ThemeInjector`, `AppScopeThemes`, `SubThemeStyles`, `FixedThemeStyles` | each | In a scope: no `:root` / `<html>.dark` write. Paints a scope root block (scope's base theme, every token group the scope registers, resolved complete over defaults) and one complete block per scope app — every theme-scope token stamped inside a scope is qualified by the scope id, so page blocks cannot match there. |
| theme-boundary `<Theme>` / portal forward | — | Stamps `data-theme-scope` qualified by `usePluginScopeId()` (`qualifyThemeScope` in ui-kit core). React contexts keep the bare token (config reads). |
| ui/icons `IconFamilyHost` (Icons.Root), `IconThemeBridge` (tokens/icons) | each | Family store and published icon styles keyed by plugin scope; `<Icon>` reads its scope's. |
| hints `HintHost` | each | One host per scope reading its own `Hints.Hint`/`Hints.Tour` and seen state through its own transport; scope-keyed registries (`inScope`) stay. |
| `DemoScope`'s `HostInputs.Supply` read | — | Read from the scope's composition (inside the `PluginScope`), values still read on the page's transport. |
| everything else (reports, layout, shortcuts, action bar, toasts, sprites, …) | page | unchanged |

`Core.Root({ slot })` entries carry no scope of their own: each mount of the
root slot (`RootSlot` contributions, e.g. `Icons.Root`) declares it.

DemoScope also wraps its scope in a scope-root theme boundary
(`<Theme name="root">`, qualified like every other token) so unthemed glue
inside the demo wears the scope's base theme, not the page's `:root`. In a
scope, `AppScopeThemes` paints a block for EVERY scope app (its own theme, else
the scope's base): a popover portaled out of the scope's DOM re-stamps only its
app's token and must still find a block.

Not in this change (different class, checked):

- **`Pane.Register`** is already `pageWide`, so its contributions reach both
  the page and the scope; the empty Settings → Config on the site is a
  separate bug (filed, not fixed here).
- **Id chips** register in a module registry at module eval (`inlineChip()`),
  not through a page-root host: an on-demand plugin's chips are there once it
  loads, on both pages.
- **Light/dark** stays one class on `<html>` (the page's): a scope whose
  scheme differs from the page's is a known gap (both the site and main are
  dark today).

## Verification

- Unit: web-sdk — a `"each"` root mounts at the page root and inside a scope
  with the scope's reader; a `"page"` one only at the root; tsc refuses a
  `Core.Root` without `scope`. theme-engine — a scope paints qualified blocks
  only; theme-boundary stamps the qualified token inside a scope.
- `./equin build` (main composition) and `./equin build --composition website`;
  screenshots of Sonata song / library, Places, Files, Settings, Agent manager
  on both, compared with ~/.equin/demo-audit-2026-11-10/.
- Demo e2e scripts (plugins/apps/plugins/demo/e2e/*.ts) and the website's
  live-demo.ts pass; tips-in-demo on the site build.
- Real app on main unchanged: screenshots of home, Sonata, Agent manager
  before/after.
