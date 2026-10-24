# An app's display name belongs on its `AppRef`

Date: 2026-08-17
Category: global (`primitives/pane` + `apps-core` + every app shell)

## Context

An app's identity is authored once, in its shell's `core/app.ts`:

```ts
export const pagesApp = defineApp({ id: "pages", basePath: "/pages", iconKey: "description" });
```

That `AppRef` carries an id, a base path and an icon key — but **no human-readable
name**. The name exists only as the `tooltip` prop of the app shell's `Apps.App`
web contribution (`tooltip: "Pages"`), which lives in `plugins/apps-core/web` —
a layer the low-level consumers cannot reach.

The concrete symptom is the pane Expand button. `usePromote()` already knows
exactly where the click will land: when a pane is hosted by an app that is not
its home app, Expand hands the pane's app-rooted URL to the tab manager. It
knows the destination `AppRef`. But `PaneChrome` can only say **"Expand pane"**,
because the destination's name is unavailable where the label is built. It
should say **"Open in Pages"**.

Every future affordance that points at an app hits the same wall ("Move to
Mail", "This lives in Sonata", an app picker outside `apps-core`).

Meanwhile the *current* arrangement already costs us a check. `Apps.App`
restates three facts the `AppRef` already holds — `id`, `path`, `tooltip` — and
`apps-paths-from-app-ref` (a whole check plugin) exists purely to statically
verify that two of the three are written as `<app>.id` / `<app>.basePath`. The
third (`tooltip`) has no check at all, so an app's name can silently differ from
itself in two places once it exists in two places.

## Intended outcome

1. `AppRef` carries `name`. One authoring site per app.
2. `Apps.App` takes the `AppRef` itself and restates **nothing** — id, path and
   name are derived. Drift becomes unspellable (ladder rung 1), so the
   `apps-paths-from-app-ref` check is deleted rather than extended.
3. The pane Expand button names its destination: **"Open in Pages"**.

## Design

### 1. `name` on `AppRef`

`plugins/primitives/plugins/pane/core/route.ts`:

```ts
export interface AppRef {
  readonly id: string;
  /** Human-readable app name, e.g. "Pages", "Agent manager". The one place an
   *  app's display name is authored — chrome that points AT an app (rail
   *  tooltip, tab fallback title, pane Expand) reads it from here. */
  readonly name: string;
  readonly basePath: string;
  readonly iconKey: string;
}
```

`defineApp` gains the required `name` field. Required, not optional: an app that
cannot be named cannot be pointed at, and there is no sensible derivation from
an id (`agent-manager` → "Agent manager"? "Agent Manager"?) — the shell says it.

Every `defineApp` call site gains `name:` — 16 app shells (`plugins/apps/plugins/
<app>/plugins/shell/core/app.ts`) plus ~9 test fixtures under
`plugins/primitives/plugins/pane/`. The value is copied verbatim from the shell's
existing `Apps.App({ tooltip })`, so nothing user-visible changes.

### 2. `Apps.App` takes the `AppRef`

`plugins/apps-core/web/slots.ts` today:

```ts
Apps.App({ id: pagesApp.id, icon: mdAppIcon(MdDescription), tooltip: "Pages",
           component: PagesLayout, path: pagesApp.basePath })
```

after:

```ts
Apps.App({ app: pagesApp, icon: mdAppIcon(MdDescription), component: PagesLayout })
```

The slot's props become `{ app: AppRef; icon; component; onClick?; default?;
badge? }`. `id` / `path` / `tooltip` are gone from the authoring surface.

The framework requires every render-slot contribution to carry an `id`, so
`apps-core` derives it. `Apps.App` becomes a thin factory wrapping the raw slot,
keeping the exact `Apps.App({…})` call shape every other slot has:

```ts
const appSlot = defineRenderSlot<AppEntry>("apps.app", { docLabel: (p) => p.app.name });

// The contribution restates nothing about the app; the framework-level
// contribution id is derived from the AppRef so it cannot drift from it.
App: Object.assign(
  (entry: AppEntry) => appSlot({ ...entry, id: entry.app.id }),
  appSlot,
),
```

(If the intersection type reads badly at call sites, declare the callable
interface explicitly instead — the requirement is only that `Apps.App({…})`,
`Apps.App.Render`, `Apps.App.useContributions()` and `Apps.App.id` all keep
working, since `tab-surface` renders through `Apps.App.id` and several plugins
read `useContributions()`.)

Consumers migrate mechanically:

| before | after |
|---|---|
| `a.tooltip` | `a.app.name` |
| `a.path` | `a.app.basePath` |
| `a.id` | unchanged (still the app id, now derived) |

Known consumer sites (~12): `apps-core/web/internal/resolve-app.ts`,
`apps-core/plugins/layout/.../apps-layout.tsx`,
`apps-core/plugins/tab-bar/.../app-tab-bar.tsx`,
`apps-core/plugins/tabs/web/internal/tabs-store.ts`,
`apps-core/plugins/surface/plugins/floating/**` (window dock + placement),
`apps/home/plugins/app-cards/**` (its DataView "Name" column is literally
`a.tooltip` today), `config_v2/plugins/settings/.../scope-tabs.tsx`,
`ui/theme-engine/.../theme-injector.tsx`, plus the tabs jsdom test fixtures.

One raw-contribution reader needs care:
`plugins/framework/plugins/web-core/web/App.tsx` (`resolveActiveAppPrefix`)
matches pre-boot on `c._slotId === "apps.app" && typeof c.path === "string"` —
it becomes a read of `c.app.basePath` off the raw (unsealed) contribution.

**Delete** `plugins/framework/plugins/tooling/plugins/checks/plugins/apps-paths-from-app-ref/`
— its entire invariant is now a type error.

### 3. Expand names its destination

`usePromote()` currently returns `((opts?) => void) | null`, which erases the one
thing the label needs: *which of the two destinations* this is. Make the
destination part of the return value:

```ts
export type PromoteAction =
  /** Hand off to another app — this pane is being hosted away from home. */
  | { kind: "cross-app"; app: AppRef; run: (opts?: { newTab?: boolean }) => void }
  /** Re-root here: drop the ancestors, same app. */
  | { kind: "re-root"; run: (opts?: { newTab?: boolean }) => void };

usePromote(): PromoteAction | null;
```

The two callers (`pane-chrome.tsx`, `pane-resolve-guard.tsx`) label from it:

```tsx
label={promote.kind === "cross-app" ? `Open in ${promote.app.name}` : "Expand pane"}
{...linkGestureProps(promote.run)}
```

so a page stranded in the agent manager offers **"Open in Pages"**, while an
in-app promote keeps **"Expand pane"**. Same icon (`MdOpenInFull`), same
position — only the tooltip/aria-label gains the destination. `null` still means
"nowhere to go" and paints no button.

## Files

- `plugins/primitives/plugins/pane/core/route.ts` — `AppRef.name`, `defineApp`.
- `plugins/primitives/plugins/pane/web/pane.ts` — `PromoteAction`, `usePromote`.
- `plugins/primitives/plugins/pane/web/components/{pane-chrome,pane-resolve-guard}.tsx` — label.
- `plugins/primitives/plugins/pane/web/index.ts` — export `PromoteAction`.
- `plugins/apps-core/web/slots.ts` — `Apps.App` takes `app: AppRef`.
- `plugins/apps/plugins/*/plugins/shell/core/app.ts` ×16 — add `name`.
- `plugins/apps/plugins/*/plugins/shell/web/index.ts` ×16 — `app:` replaces `id`/`path`/`tooltip`.
- ~12 consumer sites listed above + jsdom fixtures.
- Delete `plugins/framework/plugins/tooling/plugins/checks/plugins/apps-paths-from-app-ref/`.
- Docs: `plugins/primitives/plugins/pane/CLAUDE.md` (Expand section + AppRef),
  `plugins/apps-core/CLAUDE.md` if it describes the contribution.

## Verification

1. `./equin check` — type-check + boundaries + `plugins-doc-in-sync`
   (the deleted check must disappear from the generated docs), and confirm
   `apps-paths-from-app-ref` is no longer listed by `./equin check --list`.
2. `./equin test plugins/primitives/plugins/pane plugins/apps-core` —
   the pane jsdom suites and the tabs history/boot suites exercise `defineApp`
   fixtures and `.path`/`.id` reads.
3. `./equin build`, then in the deployed app:
   - the app rail still shows every app's tooltip, and the tab bar still falls
     back to the app name for an untitled tab;
   - Home's launcher grid still lists app names;
   - open a Pages page inside the agent manager (a conversation with a page
     pane) and hover Expand — it must read **"Open in Pages"**; hover Expand on
     an in-app nested pane — it must still read "Expand pane".
   - `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts
     --url http://<worktree>.localhost:9000/agents --out /tmp/apps` for a
     visual smoke check of the rail/tab chrome.
