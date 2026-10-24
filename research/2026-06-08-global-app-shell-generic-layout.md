# AppShellLayout: decouple chrome from the layout renderer

## Context

`AppShellLayout` (`plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`)
is the reusable **sidebar + toolbar chrome**. But its `<main>` hardwires
`<MillerColumns/>`:

```tsx
import { MillerColumns } from "@plugins/layouts/plugins/miller/web";
...
<main className="min-h-0 flex-1 overflow-hidden bg-muted/30">
  <MillerColumns />
</main>
```

Consequences of the hardwire:

- **Chrome is welded to one layout.** Any app that wants the shared
  sidebar+toolbar chrome is forced into a Miller-columns main area. A
  full-surface or mixed app cannot reuse the chrome.
- **Sonata forgoes the chrome entirely** (`sonata-layout.tsx` mounts a bare
  `<FullPane/>`) *because it cannot get chrome without Miller* — not because
  it positively wants no chrome at the framework level.
- **A primitive depends on a feature-area layout plugin.** `app-shell` (a
  `primitives/` plugin) imports `@plugins/layouts/plugins/miller`. The two
  concerns — *chrome* and *how the pane route is composed* — are genuinely
  orthogonal, yet the dependency graph couples them.
- The existing layout renderers (`FullPane`, `MillerColumns`, the mixing
  `PaneLayoutHost`) are already interchangeable components that self-resolve
  the route. They are drop-in alternatives for the `<main>` content. The only
  thing preventing composition is that `AppShellLayout` hardcodes the choice.

### Decision

**Yes — decouple, but not by parameterizing the renderer with a default.** The
right primitive is *orthogonal composition*: `AppShellLayout` provides chrome
and renders **`children`** in its main area. The app composes chrome + its
chosen renderer at the call site. No new abstraction is needed — `FullPane` /
`MillerColumns` / `PaneLayoutHost` already are the renderer abstraction; the
fix is to stop `AppShellLayout` from picking one.

This is preferred over a `renderer?: ComponentType` prop **defaulting to
Miller**, because the default would keep the `app-shell → miller` dependency
alive and keep one layout privileged. Making the main area an explicit child:

- removes the `app-shell → layouts/miller` edge entirely (chrome becomes a
  pure `primitives/` component with no layout dependency);
- makes each app's renderer choice explicit and local at its shell;
- makes "shell chrome + full-surface main" a first-class, supported
  combination (just `<AppShellLayout …><FullPane/></AppShellLayout>`).

Yes, "chrome + full-surface main" is desirable: an app may want the app rail
trigger, toolbar actions, and sidebar nav while a single pane fills the body.
Sonata stays bare by choice; the framework no longer forbids the combination.

## Change

### 1. `AppShellLayout` becomes renderer-agnostic

`plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`

- Drop `import { MillerColumns } from "@plugins/layouts/plugins/miller/web";`.
- Add `children: ReactNode` to the props.
- Render `{children}` in place of `<MillerColumns />`:

```tsx
export function AppShellLayout({
  sidebarSlot,
  toolbarSlot,
  header,
  children,
}: {
  sidebarSlot: RenderSlot<AppShellSidebarItem>;
  toolbarSlot: RenderSlot<AppShellToolbarItem>;
  header?: ReactNode;
  children: ReactNode;
}) {
  ...
  <main className="min-h-0 flex-1 overflow-hidden bg-muted/30">
    {children}
  </main>
}
```

`children` is **required** (no default) — every app declares its renderer
explicitly. This is what removes the privileged-layout coupling.

### 2. Update the six Miller call sites

Each adds the miller import and nests `<MillerColumns/>` as a child. The import
is a legal cross-plugin barrel import (these files already import the
`app-shell` barrel; `@plugins/layouts/plugins/miller/web` is equally legal).

- `plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx`
- `plugins/apps/plugins/forge/plugins/shell/web/components/forge-layout.tsx`
- `plugins/apps/plugins/pages/plugins/shell/web/components/pages-layout.tsx`
- `plugins/apps/plugins/debug/plugins/shell/web/components/debug-layout.tsx`
- `plugins/apps/plugins/file-explorer/plugins/shell/web/components/file-explorer-layout.tsx`
- `plugins/apps/plugins/workflows/plugins/shell/web/components/workflows-layout.tsx`

Pattern (agent-manager shown):

```tsx
import { MillerColumns } from "@plugins/layouts/plugins/miller/web";
...
<AppShellLayout
  sidebarSlot={Shell.Sidebar}
  toolbarSlot={Shell.Toolbar}
  header={<a href="/agents">…</a>}
>
  <MillerColumns />
</AppShellLayout>
```

### 3. Docs

- Update `plugins/primitives/plugins/app-shell/CLAUDE.md` and the
  plugin description: "Reusable sidebar + toolbar **chrome**; the app supplies
  the main-area layout renderer as children." (Drop "miller-columns".)
- `./equin build` regenerates the autogen reference blocks /
  `plugins-*.md`; the `plugins-doc-in-sync` check keeps them honest.

## Out of scope (noted, not changed)

- **Sonata** keeps its bare `<FullPane/>` — it deliberately wants no chrome.
  The change only makes chrome+full-surface *possible*, it does not impose it.
- **Home** keeps its bare scrollable page (no chrome, no pane renderer).
- **Deploy** (`deploy-layout.tsx`) mounts a bare `<MillerColumns/>` with its
  own `PaneBasePathContext value=""` and no chrome — left as-is. It could later
  adopt `AppShellLayout` if it wants chrome, but that is an app decision, not
  part of this refactor.
- `PaneLayoutHost` is unchanged; it already composes as a child
  (`<AppShellLayout …><PaneLayoutHost full={[…]}/></AppShellLayout>`) for any
  future mixed app that also wants chrome.

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` | Remove miller import; add required `children`; render `{children}` in `<main>` |
| 6 app shell layout files (above) | Add miller import; nest `<MillerColumns/>` as child |
| `plugins/primitives/plugins/app-shell/CLAUDE.md` | Reword description (chrome, not miller) |

No schema, server, or barrel-export changes. `app-shell`'s web barrel exports
are unchanged.

## Verification

1. `./equin build` — must succeed (type-check + frontend build).
2. `./equin check plugin-boundaries` — confirms:
   - the new `app-shell → layouts/miller` edge is **gone** (app-shell no longer
     imports a layout plugin),
   - the 6 new `<app>/shell → layouts/miller` edges are legal barrel imports,
   - no cycles introduced.
3. `./equin check` (full) — `eslint`, `plugins-doc-in-sync`, etc.
4. Manual smoke via Playwright at `http://<worktree>.localhost:9000`:
   - `/agents`, `/forge`, `/pages`, `/debug`, `/files`, `/workflows` — sidebar +
     toolbar chrome present, Miller columns render and drill-down works
     (unchanged behavior).
   - `/sonata`, `/home` — unaffected (still full-pane / bare page).

   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --out /tmp/shell-agents
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/forge  --out /tmp/shell-forge
   ```

   Expect identical rendering to before the change — this refactor is
   behavior-preserving for all current apps; it only widens what `AppShellLayout`
   can host.
