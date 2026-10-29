# Deploy app: sites-first redesign

Prototype: `proto-1793181461-uvir4e` (`~/.equin/apps/prototypes/proto-1793181461-uvir4e/index.html`) — the target, pixel-perfect.

## Context

The Deploy app is server-first: Servers list → server pane (collapsible cards, one of them a Deployments DataView) → deployment pane with ~10 collapsed cards. Anything a user actually opens the app for — traffic, visitor messages, "is my latest commit live?" — sits three clicks deep, and the UI is generic (stacked accordions, default theme).

The redesign makes the **site** (a deployment: composition × server × hostnames) the primary entity:

- a sidebar listing sites and servers, plus Overview and Activity;
- a site page with a header (domains, status, **Deploy**), an always-visible **production strip** (status, running commit + subject, deployed, server, bundle) with the one banner that needs attention (behind main / failed / deploying with steps + log tail / secret needs approval);
- tabs **Overview · Analytics · Messages · Deployments · Settings**; Overview shows traffic, messages, recent deploys and checks at a glance (analytics: 0 clicks);
- a server page as infrastructure (health, SSH, connection, sites on it);
- an Activity page: one multi-view DataView of runs (view pills like the build popover's);
- a dedicated dark theme (Vercel/Linear-like graphite + indigo accent).

User decisions (2026-10-28): **dark only**; in scope: **commit subject + behind main**, **Activity page**. Out of scope: rollback, unread-message state (prototype elements dropped: "Roll back to this", unread dots — the Messages badge counts accepted messages from the last 7 days instead, see §6).

## Dependency spine

`deployments` owns the site page host and all its slots; every feature plugin contributes. Import edges stay one-way (`remote-deploy`, `local-serve`, `deploy-secrets/approvals`, `analytics/dashboard`, `site-messages/inbox`, `deploy-history`, `health` → `deployments`); `deployments` names no contributor (collection-consumer separation).

The app index route moves to the shell so `deployments` stops being parented under `servers`:

- `shell/core/routes.ts`: `deployIndexRoute = defineRoute({ id: "deploy-index", segment: "" })`.
- `servers/core/routes.ts`: `serverDetailRoute` (`server/:serverId`) parented on `deployIndexRoute`; `serversRoute` becomes `servers` (list page).
- `deployments/core/routes.ts`: `siteRoute = defineRoute({ id: "deploy-site", segment: "site/:deploymentId/:tab?", parent: deployIndexRoute })` — the optional trailing `:param?` is the pane system's prescribed "which tab of the entity" form (`primitives/pane/CLAUDE.md` §segments; precedent `proto/:name/:stage?`). Bare `site/x` = Overview.
- `deploymentDetailRoute` (`server/:s/dep/:d`) is deleted; for old links, a legacy pane on that route replace-navigates to `siteRoute` (removed in the cleanup phase).

## 1. Layout + sidebar (shell)

- `shell/web/components/deploy-layout.tsx`: `<AppShellLayout sidebarSlot={Deploy.Sidebar}><FullPane/></AppShellLayout>` — every page fills the main area (no Miller columns). Model: `apps/plugins/pages/plugins/shell/web/components/pages-layout.tsx`, `layouts/full-pane`.
- `shell/web/slots.ts`: `Deploy.Sidebar = defineRenderSlot<AppShellSidebarItem>(…)` (same shape as `Mail.Sidebar`, `apps/plugins/mail/plugins/shell/web/slots.ts`).
- Contributions:
  - `deployments`: nav `Overview` (`opensPane(sitesIndexPane)`) and a **Sites** custom section (`SidebarPaneSection`, "+" in `labelExtra` → add-deployment dialog, reused from `deployments/web/components/add-deployment-dialog.tsx`). Rows: live `deployments` collection, status dot from a `useSiteStatus(deploymentId)` hook (below), active when `sitePane` matches. Sidebar nav is chrome (`// eslint-disable-next-line data-view/no-adhoc-row-list -- sidebar navigation`), same as Pages' tree.
  - `servers`: **Servers** section, rows with the health dot (`health` exposes `useServerHealthMap`; `servers` cannot import `health` — cycle — so `health` contributes the Servers section instead, reading `servers`' collection). "+" → `serverDetailPane` with `NEW_SERVER_ID`.
  - `deploy-history`: nav `Activity` (`opensPane(activityPane)`).
  - Footer "All systems reachable": `health` contributes a sidebar footer item if `AppShellSidebarItem` supports it; otherwise dropped (no new primitive for it).
- `AppShell.Brand`: the rocket mark + "Deploy" (`shell/web/index.ts`).

## 2. Theme (shell)

- `shell/web/internal/theme.ts`: `deployGraphiteTheme = defineTheme({ id: "deploy-graphite", label: "Deploy Graphite", fragments })`, modelled on `apps/plugins/browser/plugins/shell/web/internal/theme.ts`. Dark only → `both(...)` everywhere. Fragments: `color-palette` (background `#0a0a0c`, card/popover `#111114`, muted/raised `#17171b`, accent hover `#1d1d22`, border/input `#24242b`, foreground `#ededf0`, mutedForeground `#94949e`, faintForeground `#60606a`, primary/ring `#6d5efc`, success `#3ecf8e`, warning `#f5a524`, destructive `#f2555a`, info = primary), `sidebar-palette` (bg = background), `font-family` (Inter, `fontMono` JetBrains Mono via `ui/tokens/font-family/plugins/google-fonts`, antialiased), `type-scale` (13px body, 22px title), `shape` (`radius` 0.625rem), `shadow` (the hairline inset + soft drop), `chart` (indigo-led `chart-1..5`).
- `shell/web/index.ts`: `ThemeEngine.Theme(deployGraphiteTheme)`; `config/ui/theme-engine/@app/deploy/theme.jsonc` → `{ "theme": "deploy-graphite" }`; `shell/core/app.ts`: `colorMode: "dark"`.
- Every component uses tokens / ui-kit only (`Card`, `Badge` pill variants success/warning/destructive/primary, `StatusDot`, `Button` default/outline/ghost/destructive, `Text` variants, `tabular-nums`); no hex outside the theme file.

## 3. Tabs primitive (extend `primitives/tabbed-view`)

Site tabs are mutually exclusive full views — what `defineTabbedView` models (`tabbed-view/web/internal/define-tabbed-view.tsx`, used today only by debug). Extend it rather than add a tab dimension to detail-sections:

```ts
// View contribution gains two optional hooks
{ id, title, icon, component,
  useAvailable?: (p: P) => boolean,                 // false → tab hidden
  useBadge?: (p: P) => { count: number } | null }   // e.g. Messages
// Host gains controlled mode
Host: P & { header?, className?, activeId?: string, onActiveChange?: (id: string) => void }
```

- Controlled: the site page passes `sitePane.useParams().tab` / sets it with a replace navigation, so a tab is an address (`/deploy/site/<id>/analytics`). Uncontrolled hosts (debug) keep `useActiveViewId`.
- Availability: each option is evaluated by a per-contribution gate component (same technique detail-sections uses for `useAvailable`, reuse its helper); an unavailable active tab falls back to the first available.
- Visual: the underline tab strip with count badge — add `variant: "underline"` to `primitives/view-switcher` (it is a `SegmentedControl` wrapper; add the variant to `css/plugins/toggle-chip` if that is where variants live).
- `deployments/web/slots.ts`: `SiteTabs = defineTabbedView<{ deploymentId: string }>("deploy.site")`; order from its reorder config.

| Tab | Contributor | Gate / badge |
|---|---|---|
| Overview | `deployments` | — |
| Analytics | `analytics/dashboard` (existing dashboard, re-homed from its section) | `useAnalyticsAvailable` |
| Messages | `site-messages/inbox` | `useMessagesAvailable`; badge §6 |
| Deployments | `deploy-history` (existing history DataView, table view first) | — |
| Settings | `deployments` | — |

## 4. Site page host (deployments)

`deployments/web/panes.tsx`: `sitePane = Pane.define({ route: siteRoute, app: deployApp, component: SitePage, useResolve: resolveRow(useLiveRow(deployments, id)), title: { useText: primaryHostname } })`.

`deployments/web/components/site-page.tsx` composes four slots (all in `deployments/web/slots.ts`):

| Slot | Shape | Contributions |
|---|---|---|
| `SiteHeader.Action` | render slot `{ id, component({deploymentId}) }` | Deploy button ← `remote-deploy` (state label: Redeploy / Deploy N commits / Retry deploy / Deploying…; disabled + tooltip from `useBlockedReason`); Test locally ← `local-serve` (`ServeAction`, moved out of `DeploymentItemActions`) |
| `SiteStrip.Cell` | render slot `{ id, label, component }` | Status, Running (sha + subject), Deployed, Bundle ← `remote-deploy`; Server ← `health` |
| `SiteBanner` | `{ id, useBanner(p) → { tone, title, body, actions } \| null, component? }`; host renders the first non-null in slot order | deploying (phase `Steps` + `LiveLogChannel` tail), failed (message verbatim + Investigate), behind main ← `remote-deploy`; secret needs approval ← `approvals` |
| `SiteTabs` | §3 | §3 |

Header itself (site icon = first letter, primary hostname, status pill, hostnames as external links, composition chip) is the host's, from the entity + `useSiteStatus`.

`useSiteStatus(deploymentId)` — `deployments/web`: folds the live `deployRuns` entry (already `deployments/core/runs.ts`) into `live | deploying | failed | needs-approval | pending`. "Behind main" is not a status here (it is `remote-deploy`'s banner/bundle cell), keeping the host free of release knowledge.

The existing `DeploymentDetail` sections are **re-homed, not rewritten**: `deploy` + `output` become the deploying banner / header action; `history`, `analytics`, `messages` become tabs; `serve` becomes the header action; the rest go to Settings.

### Settings tab

`DeploymentDetail` (renamed `SiteSettings`, still `defineDetailSections<{deploymentId}>`, card chrome — no collapse: sections without collapse affordance if supported, else all `useDefaultOpen: () => true`) keeps: General (`deployments` overview fields: hostnames tag input, loopback port, server), Secrets (`approvals`, unchanged DataView), Composition (`composition`), Install (`deployments` derived values with copy), Danger zone (new, `deployments`: remove deployment via existing delete endpoint). A left anchor nav lists the sections (`useRevealSection`).

### Overview tab

`deployments` hosts a two-column grid (main / 340px side; css `Grid` primitive) of a `SiteOverview.Card` render slot `{ id, column: "main" | "side", component }`, wrapped in `SectionCard`:

- Traffic (main) ← `analytics/dashboard`: reuses its `KpiTiles` + `TrendChart` over ONE query `{ range: "30d", compare: true, filters: [] }`; "Top pages" / "Top sources" (main, side-by-side) from the same report's `rows.page` / `rows.channel` via `RankedPanel` (non-filtering, click → Analytics tab). Same canonical params as the Analytics tab's default → one SSH snapshot shared; verify the live runtime dedups by params.
- Messages (side) ← `inbox`: newest 3 accepted.
- Deployments (side) ← `deploy-history`: `deployRunHistory` limit 4.
- Checks (side) ← `deployments` host card over a `SiteCheck` slot `{ id, useCheck(p) → { state: ok|warn|fail|pending, label, detail, fix?: LinkTarget } }`: Server reachable ← `health`; Secrets approved ← `approvals`; Bundle up to date ← `remote-deploy`; Health check after ship ← `remote-deploy` (from the last run's ship leg result, if recorded; otherwise omitted).

## 5. Other pages

- **Sites index** (`sitesIndexPane`, `appIndex: true`, `deployments`): DataView over `deployments` with a card view (`views={["cards", "list"]}`), card = icon, hostname, composition · server, status pill, 30d visitors sparkline (contributed field from `analytics` via the DataView field-extension slot — gated, cheap only if the snapshot is shared; else omitted), last commit. Header actions Add server / New site.
- **Server page** (`servers`): `ServerDetail` sections kept (identity → "Connection", status → "Health" with checks layout, ssh-setup → "SSH key"), restyled through the theme; two-column layout like the site Overview (needs `ServerDetail` sections to declare a `column` — add via `Extra` of `defineDetailSections`, the Sonata area precedent). `deployments`' "Deployments" section becomes **Sites on this server** (rows link to `sitePane`, contributed sparkline field). Danger zone = the delete action moved out of the identity card header.
- **Activity** (`activityPane`, `deploy-history`): the user asked for the build popover's multi-view runs surface. Reuse `RunsDataView` (`plugins/runs/web/components/runs-data-view.tsx`) but with its own view instances: add a `storageKey` prop (today fixed to `RUNS_VIEW`) so a host can bring its own view config; `config/apps/deploy/activity.jsonc` (shape of `config/runs/runs.jsonc`) defines pills **All deploys / Running / Needs approval / Failed / per-verb**, each filtered on `kind is deploy`. Row click → arm link, retargeted to `sitePane` tab `deployments` (`runs-arm/web/internal/deploy-run-link.ts`). Messages are not in v1 Activity (no cross-site source without N SSH reads); noted as follow-up.

## 6. Server work in scope

1. **Commit subject.** Add `commit_subject text null` to `deploy_runs` (`deployments/server/internal/tables.ts`; migration via `./equin build`), stamped wherever `commit_sha` is stamped (from the pinned bundle manifest's sha → `git log -1 --format=%s <sha>` in the orchestrator, `deployments/server/internal/run-state.ts`). Carried on `DeployRun` and `deployRunHistory` fields; History/Overview rows show sha + subject. Old rows: null → sha only.
2. **Running commit vs main.** New live value `deploy.running-commit` (`remote-deploy/core` + server loader): `{ deploymentId } → { kind: "known", sha, subject, behindMain: number, mainSha } | { kind: "unknown", reason }`, where `sha` is the newest succeeded run's `commitSha` and `behindMain = git rev-list --count <sha>..main` on the main ref (not the worktree HEAD). Invalidation: the change source the bundle provenance already uses for ref moves (`release/plugins/bundles/server/internal/provenance.ts`) plus the `deploy_runs` change feed. Drives the "Behind main" banner, the Deploy button label ("Deploy 12 commits"), the Bundle cell and the Bundle check; `See changes` opens the commit range in `code-explorer` (`commit-detail`).
3. **Messages badge without unread state**: count of accepted messages newer than 7 days from the existing snapshot (`deploymentSiteMessages`); reading it is the SSH snapshot the tab needs anyway, so the badge only renders once the Messages data has been read on this mount (no extra SSH on every page view — the badge hook reads with `load: snapshot` only when the Overview's Messages card is mounted, which it is on Overview).

4. **Roll back to a run (in scope, user request).** A hover action on succeeded History rows (`deploy-history/plugins/rollback`, a `DeployRunItemActions` contribution) that, after a `confirmDialog`, re-ships that run's pinned bundle through the existing `runDeployment` endpoint (`{ verb: "ship", release: row.releaseRunId }`) — no new endpoint, no converge, no build. Disabled with the reason as tooltip when the run pinned no release, when it is the run live now (newest succeeded `ship`/`update`), or while `useBlockedReason` blocks. A pruned bundle fails the new run with the CLI's `no-such-run`, verbatim. A pinned `ship` now stamps `commit_sha`/`commit_subject` at claim from `release_runs.commit_sha`, so `deploy.running-commit` stays known after a rollback.

Barrel exports needed (each moved to its owner's `web`/`core` barrel, no re-exports): `useReleaseInfo` (remote-deploy, internal use only — stays private since remote-deploy contributes all its surfaces), dashboard `KpiTiles`/`TrendChart`/`RankedPanel` stay private (dashboard contributes the Overview cards itself), `useDeploymentShips` already public in `host-query/web`.

## 7. Phases (each lands on its own)

1. **Routing + layout**: `deployIndexRoute`, `siteRoute`, `sitePane` wrapping today's `DeploymentDetail.Host`, legacy redirect, callers updated (`runs-arm/web/internal/deploy-run-link.ts`, `deployments/web/components/approval-links.tsx`, `deployments-section.tsx`), `FullPane`, sidebar + `Deploy.Sidebar` contributions, sites index list.
2. **Theme**: `deploy-graphite` + config + `colorMode: "dark"`.
3. **Tabs**: `tabbed-view` extension (+ tests in `tabbed-view/web/__tests__/`), `view-switcher` underline variant, `SiteTabs`; re-home analytics / messages / history / settings.
4. **Header, strip, banners**: the three slots, re-home deploy/output/serve; `useSiteStatus`.
5. **Overview tab + checks**; sites index cards; server page layout + Sites on this server.
6. **Server data**: commit subject column, `deploy.running-commit` value, the rollback row action (§6.4); wire into strip/banner/button/check.
7. **Activity**: `RunsDataView` `storageKey`, `activity.jsonc` views, link retarget.
8. **Cleanup**: legacy pane, dead sections, `DeploymentDetail` rename leftovers; pixel pass against the prototype.

Phases 3–5 are independent after 1; 6 and 7 are independent of each other. Implementation can be parallelised per phase in separate worktrees (Sonnet subagents for 2, 7; Opus for 3, 4, 6).

## Verification

- `./equin check` (boundary-rules, plugin-boundaries, pane segments-unique, plugins-registry-in-sync, theme-declarations-in-sync, migrations-in-sync, type-check/eslint incl. no-adhoc-layout / no-adhoc-surface / no-adhoc-row-list).
- `./equin test plugins/primitives/plugins/tabbed-view plugins/runs plugins/apps/plugins/deploy` — new tests: controlled tab host, `useAvailable` hide + fallback, badge; `useSiteStatus` fold; running-commit value (behind count, unknown arms); commit_subject stamping.
- `./equin build`, then drive the worktree build:
  - `browser_navigate /deploy` → sites index; sidebar → site → each tab; URL `/deploy/site/<id>/analytics` deep-links; old `/deploy/server/<s>/dep/<d>` redirects.
  - Deploy a site from the header (worktree DB only — main is read-only): banner shows steps + log, then history row with subject.
  - Activity pills filter; row opens the site's Deployments tab.
- Pixel compare per page: `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1793181461-uvir4e` (prototype `mocks` = `app:/deploy`), for each `state` option against the matching real state.

## Implemented / deviations (2026-10-29)

All eight phases landed (uncommitted on the attempt branch). What differs from the plan above:

- **Rollback is in.** The context paragraph lists it as out of scope; §6.4 (later user request) won — `deploy-history/plugins/rollback` ships the `DeployRunItemActions` row action as described.
- **`DeploymentDetail` keeps its name.** The Settings tab is `SiteSettingsTab` over the `DeploymentDetail` sections; the slot was not renamed because its id is persisted (`resolveIn` / `approvalSections` on held runs, reorder config). No collapse affordance: every section `useDefaultOpen: () => true`, a left anchor rail via `useRevealSection`.
- **Legacy pane kept, not removed in cleanup.** `legacyDeploymentPane` (`server/:serverId/dep/:deploymentId`, old pane id) still replace-forwards to `sitePane`, so bookmarks, stored notification links and restored tab history keep landing. Delete once no persisted link can name it.
- **Sites index** is a DataView with `views={["gallery", "list", "table"]}` — the gallery view gained an opt-in `panel` card (`data-view/gallery/web/components/panel-card.tsx`, card meta reworked in `data-view/web/components/card-meta.tsx`) rather than a new cards view. The 30-day visitors **sparkline** and the "Deploy a composition" **add card** were not built (follow-up tasks).
- **Underline tabs** live in `css/toggle-chip` (new variant) surfaced through `view-switcher`; `tabbed-view` gained `useAvailable`, `useBadge` and the controlled `activeId` / `onActiveChange` mode (tests in `tabbed-view/web/__tests__/gates-and-control.test.tsx`).
- **Server page**: `ServerDetail` sections declare `column: "main" | "side"` (via the `Extra` param of `defineDetailSections`); a new `ServerHeader` slot carries the status / platform / Check now parts (`health`); the delete action became its own **Danger zone** section. The Server strip cell and the Server-reachable check are `deployments`' own (`server-cell.tsx`, `internal/server-check.tsx`), reading `health`'s hooks, so `health` does not import `deployments`.
- **Sidebar footer** ("All systems reachable") dropped: `AppShellSidebarItem` has no footer arm and the plan said not to add a primitive for it. `app-shell`'s `opens` entries now read the surface match, so an entry opening the app's index pane is lit at the bare root.
- **Running commit**: `deploy.running-commit` counts `behindMain` against the resolved `mainSha` it reports (not the ref, which can move between the two reads); its invalidation uses a new ref-head change source in `release/bundles/server/internal/provenance.ts`.
- **Live run map seeding**: at boot `deploy.runs` is seeded with every deployment's newest run, skipping open rows launched by another namespace (they would wedge `useBlockedReason` and the deploying banner forever) in favour of that deployment's newest finished row.
- **Banners** answer `SiteBannerSpec | null | "pending"`; a pending link stops the chain so a lower banner never flashes before a higher one is known.
- **Activity** rows still show the generic runs label rather than "Deployed <sha> <subject> to <host>"; cross-site messages in Activity and unread message state remain out (follow-up tasks).
- **Cleanup**: `RemoteDeploySection`, `OutputSection`, `LocalServeSection` deleted; `pane/e2e/push-carries-ancestor.ts` deleted — its only live instance was the old deploy row (a pane chained under a paramful parent, pushed from another pane); sites are now flat under the paramless index and no other real pane is opened that way, so the rule stays pinned by `pane/web/__tests__/open-pane-chained-params.test.tsx`. The deploy e2e scripts that drove the old accordion (`deploy-history/e2e/history-live-verify.ts`, `investigate-failure/e2e/investigate-failure.ts`, `local-serve/e2e/local-serve-verify.ts`, `remote-deploy/e2e/remote-deploy-verify.ts`, `remote-deploy/e2e/release-info-live-verify.ts`) still target `dep/:id` and section labels — follow-up task.
