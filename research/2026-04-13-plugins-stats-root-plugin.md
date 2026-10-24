# Stats root plugin

## Context

We want a place in the app to track whether equin is actually making us
more productive — how fast TODOs get completed vs. created, commit velocity,
conversation throughput, etc. This plan introduces a root `stats` plugin in
the sidebar whose body is a vertical stack of charts. Each chart is its own
nested plugin contributing to a `Stats.Chart` slot, so new metrics can be
added later without touching the host.

First chart: **cumulative commits over time** on the main repo — a minimal,
useful baseline that also exercises the slot shape end-to-end.

Name note: `stats` is a placeholder. Could later become `pulse`, `insights`,
or `metrics` — trivial rename (plugin id + route + folder).

## Shape

```
plugins/stats/
├── CLAUDE.md                         # matches sibling plugin docs
├── web/
│   ├── index.ts                      # Shell.Sidebar + Shell.Route '/stats'
│   ├── slots.ts                      # Stats.Chart slot definition
│   ├── views.tsx                     # statsPane() factory
│   └── components/
│       └── stats-panel.tsx           # renders Stats.Chart.useContributions()
└── plugins/
    └── commits-chart/
        ├── web/
        │   ├── index.ts              # contributes Stats.Chart
        │   └── components/
        │       └── commits-chart.tsx # recharts LineChart, fetches /api/stats/commits
        └── server/
            ├── index.ts              # httpRoutes registration
            └── internal/
                └── handle-commits.ts # git log on main worktree
```

Register in `web/src/plugins.ts` and `server/src/plugins.ts`
(pattern mirrors the `conversations` + nested view plugins already there).

## Slot

`plugins/stats/web/slots.ts`:

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";

export const Stats = {
  Chart: defineSlot<{
    id: string;          // stable key for React list
    title: string;
    component: ComponentType;
    group?: string;      // future: grouping/ordering
  }>("stats.chart"),
};
```

`stats-panel.tsx` calls `Stats.Chart.useContributions()` and renders each
contribution's `component` stacked vertically (simple `flex-col gap-6`
container, each chart inside a shadcn `Card`).

## Sidebar + route

`plugins/stats/web/index.ts` contributes:

- `Shell.Sidebar`: `{ title: "Stats", icon: MdInsights, group: "System", onClick: () => ShellCommands.OpenPane(statsPane()) }`
- `Shell.Route`: `{ pattern: "/stats", resolve: () => statsPane() }`

This combines the `logs` pattern (sidebar pane) with `conversation-view`'s
route contribution so the view is bookmarkable.

The root `stats` plugin has **no server code** — it's purely a slot host.
Each chart sub-plugin owns its own data endpoint.

## Backend: commits endpoint (inside `commits-chart` sub-plugin)

`GET /api/stats/commits` → `{ points: { date: string; count: number }[] }`

Implementation in `plugins/stats/plugins/commits-chart/server/internal/handle-commits.ts`:

1. Resolve main worktree root via existing `getMainWorktreeRoot()` in
   `plugins/conversations/server/internal/tmux.ts:21` — reuse, don't duplicate.
   (Move it to a shared location if import-across-plugins is awkward; otherwise
   re-export.)
2. `Bun.spawn(["/usr/bin/git", "-C", root, "log", "--format=%cI", "--reverse"])`.
3. Parse ISO timestamps, bucket by day (`YYYY-MM-DD`), then produce a running
   cumulative sum.
4. Cache in-memory with a short TTL (e.g. 30s) — commit history grows slowly
   and this is cheap to recompute.

Register via `ServerPluginDefinition.httpRoutes` (pattern from
`plugins/build/server`). Follow `server/CLAUDE.md` conventions.

## Frontend chart

`plugins/stats/plugins/commits-chart/web/components/commits-chart.tsx`:

- `useEffect` fetches `/api/stats/commits` once.
- `recharts` `LineChart` with `XAxis` (date) + `YAxis` (cumulative count),
  `CartesianGrid`, `Tooltip`. Use shadcn chart colors (`--chart-1`) so it
  respects light/dark themes — no hardcoded colors (per `plugin-core/CLAUDE.md`).
- Wrap in shadcn `Card` with `CardHeader` title "Commits over time".
- Loading + empty states.

Add `recharts` to `web/package.json` (not root — it's web-only).

## Files to create

- `plugins/stats/CLAUDE.md`
- `plugins/stats/web/{index.ts, slots.ts, views.tsx, components/stats-panel.tsx}`
- `plugins/stats/plugins/commits-chart/web/{index.ts, components/commits-chart.tsx}`
- `plugins/stats/plugins/commits-chart/server/{index.ts, internal/handle-commits.ts}`

## Files to modify

- `web/src/plugins.ts` — register `statsPlugin` + `commitsChartPlugin`.
- `server/src/plugins.ts` (or equivalent registry — confirm during impl) —
  register server plugin.
- `plugins/CLAUDE.md` — add `stats` entry (slot, sidebar, route, endpoint).
- `web/package.json` — add `recharts`.

## Verification

1. `./equin build` — must succeed (migrations check, typecheck, build).
2. Open `http://claude-1776112992.localhost:9000/stats` — sidebar entry
   "Stats" visible under System group; clicking navigates to the pane.
3. Cumulative commits chart renders, tooltip works, axes labeled, theme-aware.
4. `curl http://claude-1776112992.localhost:9000/api/stats/commits` returns
   `{ points: [...] }` with monotonically non-decreasing `count`.
5. Light/dark theme toggle — chart colors update, no hardcoded hex.
6. Screenshot check via Playwright at 1280×800.

## Open questions / follow-ups

- Final plugin name (`stats` vs `pulse`/`insights`) — deferrable rename.
- Second chart candidate (TODOs completed vs. created) — separate task once
  the slot is proven.
