# Unified status mark on the collapsed floating action bar

## Context

In fullscreen (solo) surface mode the global action bar floats top-right,
collapsed to the health report's dot (`FloatingActionBarHost`,
`plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx`).
Everything else — including the Build button, which says "Building", "Build
failed" and carries the Reload segment — is hidden until hover. So a build in
progress, a failed build, or a tab that must be reloaded is invisible.

Prototype `proto-1791276539-o3lb` (direction **hybrid**) settled the look:

- the **dot** stays health, unchanged (8 px `md` StatusDot, count + tint when
  attention/critical — exactly today's button);
- a **ring** around the dot is background activity: spinning arc while
  running, broken red ring when the last run failed; the ring takes room only
  while drawn;
- a **Reload chip** after the dot/count when this tab should reload (blue when
  stale, red when something already fails — `ReloadAdvice` semantics).

Build data has no determinate progress (`BuildRunSchema` is start/finish/exit
only), so the ring is indeterminate.

## Design

global-action-bar must not name build (collection-consumer separation), and
build already contributes to `shell/action-bar`. So `action-bar` gains two
generic slots, build contributes to both, and global-action-bar renders them
only in the floating (collapsed) host.

### 1. New primitive: `primitives/css/plugins/activity-ring`

`<ActivityRing activity={"running" | "failed" | null}>{dot}</ActivityRing>` —
wraps a child (the dot) in an SVG ring: faint track + spinning arc
(`animate-spin`, `motion-reduce` static) for `running`; dashed `destructive`
circle for `failed`; `null` renders the child alone with no reserved box (the
balance lesson from the prototype). Sized from the control-icon token of the
ambient `ControlSize`, so it scales with the dot. Pure CSS/SVG, no data.
Exports the `RingActivity` type.

### 2. `shell/action-bar`: two slots

- `ActionBar.Activity = defineSlot<{ id; useActivity: Hook<() => BarActivity | null> }>`
  where `BarActivity = { state: RingActivity; label: string }` (label feeds the
  tooltip / aria, e.g. "Building", "Build failed").
- `ActionBar.Glance = defineRenderSlot<{ component }>` — compact always-visible
  chips shown beside the collapsed mark; a contribution renders `null` when it
  has nothing to say.

### 3. `shell/health-report`: accept an activity

`HealthReportButton({ activity?: BarActivity[] })` — merges (any `running` →
running, else any `failed` → failed), wraps `HealthDot` in `ActivityRing`, and
appends the labels to the button's tooltip / `aria-label`
("All healthy · Building"). No activity → identical to today.

### 4. `shell/global-action-bar`: compose, floating host only

- `ActivityProbes` — one headless probe per `ActionBar.Activity` contribution
  (calls its `useActivity`, publishes into a scoped store), mirroring
  `health-report`'s `StatusProbes` + `HealthStore` (incl. its per-probe error
  boundary, so a crashing probe cannot take the bar down).
- Floating trigger becomes `<HealthItem activity={merged} />` followed by
  `<ActionBar.Glance.Render />`. Glance chips are hidden while the bar is open
  (`group-data-open/fa:hidden`): the expanded row shows the Build button's own
  Reload segment, so two Reload buttons never show at once.
- Docked host unchanged (Build button is already visible next to the dot).

### 5. `build`: contribute

- `ActionBar.Activity({ id: "build", useActivity: useBuildActivity })` —
  reads `useLive(buildHistory)`: latest run `finishedAt === null` → running
  ("Building" / "Building sonata"), `buildStatusOf(run) === "failed"` →
  failed ("Build failed"), else / loading / error → `null`.
- `ActionBar.Glance({ id: "reload", component: ReloadChip })` — compact filled
  pill (refresh icon + "Reload", `bg-info` / `bg-destructive`), click reloads.
  Shares `messageFor` / failing logic with `ReloadSegment` (extract to
  `web/internal/reload-copy.ts`), driven by the existing `useReloadAdvice`.
- The derivation of running/failed currently inline in `BuildButtonInner` moves
  to one helper both the button and `useBuildActivity` use.

## Files

- new `plugins/primitives/plugins/css/plugins/activity-ring/` (web barrel, CLAUDE.md)
- `plugins/shell/plugins/action-bar/web/slots.ts` (+ barrel exports)
- `plugins/shell/plugins/health-report/web/components/health-report-button.tsx`, `health-dot.tsx`
- `plugins/shell/plugins/global-action-bar/web/components/global-action-bar.tsx` (+ probes/store internal file)
- `plugins/build/web/index.ts`, `components/reload-segment.tsx`, new `components/reload-chip.tsx`, new `hooks/use-build-activity.ts`

## Verification

- `./equin test plugins/build plugins/shell` — jsdom tests: activity
  merge; `useBuildActivity` (running / failed / superseded → null); ReloadChip
  null on `none`, renders on `stale`.
- `./equin build`, then screenshot in solo mode: idle (bare dot), during a
  build (ring), after it (Reload chip), and hover-open (chip hidden, row shows
  Build + Reload).
- `./equin check` (boundaries, lint, docs in sync).
