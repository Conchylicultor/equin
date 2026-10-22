# dashboard

The deploy app's Analytics section on a deployment's page. It reads the deployed
site's report from the box and renders it; it stores nothing.

## Reading the report

The `deploy-analytics.report` live value (`core/internal/analytics.ts`) — a
typed-query value, question `{ deploymentId, query }`, `load: "snapshot"` —
is served external with `changes: { snapshot }` (`server/internal/served.ts`):
the report is the remote site's data, which changes with every visit and has
no change signal here, so it is measured when a reader asks (each mount, and
Refresh = `refresh()`), never on a timer. Its loader resolves the
deployment's server through `health`'s `resolveServerSshTarget(…, "require-pinned")`
— the same address, key and host-key rules as the connection check — and runs

```
curl -fsS -m 10 http://127.0.0.1:<loopbackPort>/api/host-only/analytics/query?q=<base64url>
```

over SSH. It goes through the install's **gateway**, never the backend socket:
`hostOnly` answers only a request with exactly the gateway's one proxy hop.

The answer is a discriminated result, never an empty report:
`report` / `refused` (collect's own result) · `no-ssh-key` · `unverified` (the host
key was never pinned; the dashboard never learns one) · `ssh-failed` (with the
SSH failure kind) · `request-failed` (curl's exit code: 7 site down, 22 HTTP
error, 28 timeout) · `unreadable-answer`. A missing deployment is refused
`missing` (the read's error arm, through `ResourceErrorInline`).

That resolution reads Postgres (deployment row, server, pinned host key, key
secret) inside the external loader: the private key and host key may only be
read server-side at SSH time, so it cannot move out, and a `db` or
reads-declaring `"notified"` arm would label the remote report fresh. It is
re-read on every measure, so it is never staler than the report. (The
`no-db-backed-notify` scan does not see this read: `resolveDeployment` reaches
the loader as an injected dependency, not a call it follows.)

**Question size.** A question must fit `LIVE_QUERY_MAX_BYTES` (2 KiB): the
id is capped at 128 chars and the filters, as canonical JSON, at
`FILTERS_MAX_BYTES` (1536) — a refine in the question schema and `filtersFit`,
the one rule `clickRow` checks before it adds or replaces a filter (a row that
would not fit is disabled with the reason). A test pins the worst case under
the limit.

`server/internal/query-over-ssh.ts` holds the argv and the mapping with the two
effects injected, so they are tested without a box. The loader is capped at two
concurrent SSH sessions (a semaphore; more readers queue).

## When the section shows

`useShipsAnalytics` asks `plugin-meta/composition`'s `useCompositionIncludes`
whether the deployment's composition resolves to a closure containing the collect
plugin (`web/internal/collect-plugin-id.ts`, pinned to the folder by a test). No
composition is ever named. Loading keeps the card (with a loading body); a
composition without collect hides it.

## The dashboard

Range, comparison, filters, chart metric and panel tabs are local state; each
change is a new question — a new tuple of `useLive(deploymentAnalytics, …)`,
loading until it is measured; nothing re-asks on focus or a timer, the refresh
button (`refresh()`) is the re-ask.

Filter rules live in `web/internal/filters.ts`: clicking a row adds its filter,
replaces another value of the same dimension, or removes its own. When
`reportSourceFor` says `totals` (the range reaches past the 90-day raw window),
a second filter is refused before asking and the chip bar says why in one line;
a raw report stacks at most collect's `MAX_FILTERS` (8). A `refused` answer (e.g. the range was widened with two filters on) renders as
an error with "keep only the first filter".

Panels are ranked top-N readouts of one fetched report, rendered as `Row`s with
a named `no-adhoc-row-list` disable: the order is the server's ranking and each
row is a filter toggle. "What one visit records" renders collect's
`RECORDED_FIELDS` / `NEVER_RECORDED`.

A row and its filter chip show a value through `dimensionValueLabel`
(`web/internal/format.ts`): a per-dimension label map, identity by default —
countries read "France (FR)" via `Intl.DisplayNames` in `navigator.language`. The stored value is still
what is filtered on. A tab can carry a `credit` (its data source, linked),
rendered after its note; Countries credits `IP_COUNTRY_SOURCE`.

## Tests

- `server/internal/query-over-ssh.test.ts` — argv, result mapping, no session
  when the deployment does not resolve.
- `core/internal/analytics.test.ts` — a question within the filters budget
  always fits `LIVE_QUERY_MAX_BYTES`; over it, the schema refuses.
- `web/internal/collect-plugin-id.test.ts` — the id names the collect folder.
- `web/__tests__/filter-rules.test.tsx` — the chip rules (incl. the filter cap
  and the size budget), as rule and as UI;
  country labels and the Countries credit.
- `web/__tests__/dashboard-states.test.tsx` — loading, a refused read, every
  error state, Refresh re-measures, and a
  report's panels (Countries rows + credit).

Run with `./singularity test plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Analytics section of a deployment's page, shown only when the deployment's composition ships the collect plugin: range and comparison controls, KPI tiles choosing a trend line with a dashed previous period, ranked Pages / Sources / Locations / Devices / Events panels whose rows filter the whole dashboard (one filter on ranges past the raw window), and what one visit records. Reads the report over SSH on demand, with explicit states for every failure. Reads a deployment's analytics report over SSH: resolves the deployment's server and pinned SSH target, curls the install's host-only report through its own gateway on the loopback port, and answers a discriminated result (report, refused, or which of SSH, the request or the answer failed).
- Web:
  - Contributes: `DeploymentDetail.Section` "Analytics" → `AnalyticsSection`
  - Uses: 29 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `network/live` ×3
    - `primitives/css/coords` ×2
    - `primitives/css/text` ×2
    - `primitives/css/ui-kit` ×2
    - `apps/deploy/deployments.DeploymentDetail`
    - `plugin-meta/composition.useCompositionIncludes`
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/badge.Badge`
    - `primitives/css/card.Card`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.Rigid`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.Switch`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/loading.Loading`
    - `primitives/relative-time.RelativeTime`
- Server:
  - Contributes: `resource.declare` "deploy-analytics.report"
  - Uses:
    - `apps/deploy/deployments._deployDeployments`
    - `apps/deploy/health.resolveServerSshTarget`
    - `database.db`
    - `infra/ssh.sshRun`
    - `network/live.serveValue`
  - Resources: `deploy-analytics.report` (invalidate, snapshot)
- Core:
  - Uses:
    - `apps/deploy/analytics/collect.AnalyticsFilter`
    - `apps/deploy/analytics/collect.AnalyticsQueryResultSchema`
    - `apps/deploy/analytics/collect.AnalyticsQuerySchema`
    - `infra/ssh.SshFailureKindSchema`
    - `network/live.liveValue`
    - `packages/canonical-params.canonicalJson`
  - Exports (types): `DeploymentAnalyticsResult`
  - Exports (values):
    - `CURL_EXIT`
    - `deploymentAnalytics`
    - `filtersFit`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/chart --chart-1`
    - `ui/tokens/chart --chart-3`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --popover-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/density --control-height-xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
- Test helpers:
  - Web: `@plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web/testing`
    - `metrics`
    - `report`
    - `row`

<!-- AUTOGENERATED:END -->
