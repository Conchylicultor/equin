# health-report

One dot that answers "is everything fine?", merged from health rows any plugin
registers, opening a short human-readable report. Fine-grained debugging stays
in Debug → Reports / Timeline; this is the high-level summary. Design:
[`research/2026-09-10-global-unified-health-report.md`](../../../../research/2026-09-10-global-unified-health-report.md).

This plugin owns the `HealthReport.Row` slot and renders it. It knows no
contributor: every row, including the worktree identity and the connection, is
a contribution from the plugin that owns that fact.

## Contributing a row

Three kinds, and the kind is the whole contract:

```ts
import { HealthReport } from "@plugins/shell/plugins/health-report/web";

// A status row: has a state, feeds the dot.
HealthReport.Row({
  kind: "status",
  id: "connection",
  title: "Connection",
  useStatus: useConnectionHealth, // () => HealthStatus
  actions: OpenDebugHealth,       // optional trailing controls
  glance: QueueBars,              // optional, under the summary
  component: QueueDetail,         // optional expandable detail
});

// An info row: says where you are, never how healthy it is.
HealthReport.Row({
  kind: "info",
  id: "worktree",
  icon: MdAccountTree,
  useInfo: useWorktreeIdentity,   // () => { title, summary }
  actions: WorktreeActions,
});

// A row set: one contribution, one status row per item of a live list.
HealthReport.Row({
  kind: "set",
  id: "sites",
  title: "Sites",                 // its one row while pending / failed
  useRows: useSiteRows,           // () => SetRows
  glance: SitePulse,              // optional, ({ rowKey, expanded })
  component: SiteDetail,          // optional, ({ rowKey })
  actions: SiteActions,           // optional, ({ rowKey })
  remedy: DeploySite,             // optional, ({ rowKey })
});
```

- **`useStatus` runs all the time**, report open or not — it is what colours the
  dot. Keep it a cheap read of state that is already resident. It returns
  `{ state: "ok" | "info" | "attention" | "critical", summary, transitioning? }`,
  `{ state: "unknown", summary? }`, `{ state: "not-applicable", summary }` or
  `{ state: "absent" }`.
- **`info` is "fine, and worth knowing"** (blue): a new version waiting, a
  deploy under way. Not a problem — it is not counted, offers no `remedy`, and
  leaves the quiet card like any non-`ok` row. With `transitioning` it pulses:
  work in progress. Use it instead of `ok` whenever green would hide something
  the user would want to see, and instead of `attention` whenever nothing
  needs them.
- **`unknown` is a state, not a stand-in.** Without a summary it means "not
  known yet": grey and pulsing, and the report says "Checking…". With one it
  means "known to be unreadable right now" ("Unknown while disconnected"): grey
  and still. Never return `ok` because you do not know yet.
- **`not-applicable` is "this check does not exist here"**, not "can't read
  it": a machine-only check under a host without the computer (its read is
  `unavailable` — return `{ state: "not-applicable", summary: result.message }`).
  The merge leaves it out, so it neither greys nor greens the dot; the row is
  listed with a hollow dot and its summary saying why.
- **`absent` is "this row has nothing to say here"**: `{ state: "absent" }` —
  the row is not drawn at all and the merge skips it (the updates row on the
  repo that has nothing to update from). Use `not-applicable` when the user
  should see that the check exists but does not apply.
- **A row whose state is its name** returns a `title` with its known state
  (`{ state: "info", title: "equin is out of date", summary: "…" }`); the
  row is drawn under that title instead of its own, and the verdict uses it.
- **Info rows cannot move the dot.** They have no field to declare a state
  through, so this holds by construction. Their `useInfo` runs only while the
  report is open.
- **The chevron exists iff a `component` does** (detail-sections' rule). The
  detail is mounted only while expanded. `glance` sits inside the row's click
  target when the row is expandable, so it must be presentational — controls go
  in `actions`. It gets `expanded` (`GlanceProps`), so it can show less while
  the row is collapsed.
- **`remedy` is the control that fixes the problem** ("Update"): drawn after
  `actions` only while the row is `attention` or `critical`. It does not keep
  the row out of the quiet card (see Merge), so a row that is summary-only
  while fine can still offer a fix when it is not.
- **A row set is N status rows from one contribution** (one per deployed
  site). `useRows` returns `{ kind: "pending" }`, `{ kind: "error", summary }`
  or `{ kind: "ready", rows: { key, title, status }[] }` (`SetRows`); it runs
  all the time, like `useStatus`, and once for the whole set — read ONE value
  that already holds every item's state. Each item is then an ordinary status
  row: merged and counted on its own, drawn where the set sits in the slot
  order, folded like any quiet row, with its own expand state. Its `title` is
  the item's (a known state's `title` still overrides it). The parts are the
  set's, told which item they draw (`rowKey`, `SetItemProps`) — one component
  instance per item, so per-item reads (a live value keyed by the item) go
  there, mounted only while the report is open. While `pending` the set is
  one grey "Checking…" row under its `title`; on `error` one grey row with the
  summary; `ready` with no items draws nothing and does not move the dot. Two
  items sharing a key crash the set's check.
- **Show your row on its own with `HealthLineView`** (web barrel): one line
  drawn from its parts (`status`, `title`, `glance`, `actions`, `detail`,
  `defaultOpen`) — the very component the report draws each status line and
  set item through, so an exhibit of a contributor's row
  (`box-link/site-row`'s `site-row/<state>`) is the row, pixel for pixel.
- **Point at your own pane from `actions`.** The report has no footer and never
  names a contributor's pane.

## Merge

`mergeHealth` (`core/merge.ts`, pure, bun-tested): precedence
`critical > attention > unknown > info > ok`, so the dot cannot claim a known
state before every status row has reported, and something worth knowing turns
it blue rather than hiding in green. `count` is the rows in attention or
critical (never `info`).
`not-applicable` rows are skipped, exactly as if unregistered.
The dot pulses while any row is not known yet or is `transitioning`.

**Zero rows is `ok`** ("All systems normal"): with nothing registered there is
nothing that could be wrong and nothing pending. The report then shows only its
header.

The verdict (`verdictOf`) is the header text, the button's tooltip and its
accessible name: "All systems normal", "Checking…", the one non-green row's own
words (its state's `title`, else its summary), "N things to know" (several
`info` rows), or "N things need attention". When every unknown row has said why it
is unknown, the verdict gives that reason instead of "Checking…".

The dot — in the action bar and in the report's header alike — is `mergeDot`:
an ambient attention row (`ambient`: the machine watcher's duress from memory
alone, the watcher already holding builds back) folds as `ok` and adds its
marks (a small icon beside the dot), so routine machine load never turns
either dot orange. The row itself still draws attention, and the verdict still
names it. This is not `info`: ambient is an attention the dot deliberately
does not show; `info` is no problem at all, shown blue.

**Quiet rows fold into one card** (`foldQuietRows`, pure, bun-tested): a
status row with nothing beyond its summary at rest (no `glance` or `actions`;
a `component` detail sits behind the row's own chevron, still expandable inside
the card, and a `remedy` is not drawn while `ok`, so neither counts) that is
`ok` only says "fine", so two or more of them collapse into one card — "System checks", "All N normal" (a generic title, never the folded titles: that list grows with every contributor) — that lists each when expanded. A row
leaves the card the moment it is not `ok`, so a problem is never behind a
chevron — but it stays beside it (just above), where it sat while fine: every
plain row, folded or not, sits after every other row, so a row leaving or
rejoining the card never shifts the rest. The rule reads only the row's shape and state, never its
id.

Row order: the slot's reorder layout
(`config/shell/health-report/shell.health-report.row.jsonc` — where a new row is
placed, with the reason beside it), read with `useSlotOrder`. `HealthReport.Row`
is a render slot the report never `.Render`s: it draws the rows itself, and on
top of the layout arranges info rows first (`sortRows`, stable) and folds the
quiet ones (`foldQuietRows`). Never by status, so a row keeps its place when it
turns red (the dot and verdict already say what is wrong). A row carries no
order number — `defineSlot` would reject one.

The The layout order is a read (`useSlotOrder` returns a `ResourceResult`): until
it is known the open report's body is a loading state — no rows, never the rows
in raw registration order. The header's verdict is drawn over every status the
probes have published (the same set the dot merges). A failed
refresh keeps the last-known order; a first read that fails shows the error
with Retry. The dot is not gated: the probes are mounted per contribution and
the merge reads no order.

## Host mechanics

`HealthReportButton` owns a scoped store (`statuses`: `Record<id, HealthStatus>`;
`sets`: each ready row set's items, in order) and mounts one headless probe per
status row and row set. Each probe calls its row's hook unconditionally (one
component per contribution, so every hook call is rules-of-hooks clean) and
publishes into the store; unmounting removes the entry. A set's probe publishes
with `withStatusesUnder`, which replaces everything under the set's id — its
own entry and every `${id}/${key}` — in one write, so a vanished item is
dropped with it; `reportedStatusesOf` is the one read of what a row feeds the
merge (the dot, the header). The dot reads the merge through a selector, so it re-renders only when
what it shows changes.

A probe whose hook throws is caught by its own boundary, which publishes
`{ state: "unknown", summary: "This check crashed" }` (a set: one such row
under its id, its items dropped) — a crashing check greys
the dot, never greens it — and files the crash through the error-boundary
plugin's `boundaryReportSink`, like every other boundary. Each panel row is
drawn through `renderAsContribution` (slot-render's item middlewares and box:
the error boundary, and the element picker's lineage, so a pick on a row names
its contributor); each row's `glance` / `actions` sit in their own
`PluginErrorBoundary`s; the `component` detail is rendered through
`renderIsolated`.

**The button is the action bar's leading mark.** This plugin contributes
`HealthReportButton` to `ActionBar.Lead` (a companion, so it ships wherever the
bar does); `global-action-bar` renders that slot first in both of its hosts —
the docked strip and the floating bar, where collapsed it IS the bar, with the
bar's activities folded onto it — without naming this plugin. The two hosts
are mutually exclusive (the pin), so exactly one button, and one live set of
probes, is mounted per page.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Unified health report: one dot merging every HealthReport.Row contribution (critical > attention > unknown > info > ok — info is blue: worth knowing, not a problem, so it is not counted — with a count of rows needing a look), opening a popover that lists info rows first, then status rows in the slot's reorder layout order. Owns the slot, and contributes its button as the action bar's leading mark (ActionBar.Lead); knows no contributor.
- Web:
  - Slots: `HealthReport.Row`
  - Slot contributors:
    - `HealthReport.Row` ← `apps.deploy.box-link.site-row`
    - `HealthReport.Row` ← `build`
    - `HealthReport.Row` ← `conversations.runtime-sdk`
    - `HealthReport.Row` ← `database.query-deadline`
    - `HealthReport.Row` ← `debug.queue-health`
    - `HealthReport.Row` ← `debug.sentinel.health-row`
    - `HealthReport.Row` ← `infra.deps.pin-drift`
    - `HealthReport.Row` ← `infra.health.connection-row`
    - `HealthReport.Row` ← `infra.host.io-health`
    - `HealthReport.Row` ← `infra.launcher.gateway-drift`
    - `HealthReport.Row` ← `infra.mcp.browser`
    - `HealthReport.Row` ← `infra.mcp.health`
    - `HealthReport.Row` ← `integrations.github-events`
    - `HealthReport.Row` ← `primitives.dom.web-storage.health`
    - `HealthReport.Row` ← `reports.resource-errors`
    - `HealthReport.Row` ← `tasks.worktree-identity`
    - `HealthReport.Row` ← `upstream`
  - Contributes: `ActionBar.Lead` → `HealthReportButton`
  - Uses: 31 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/collapsible` ×4
    - `primitives/slot-render` ×4
    - `primitives/css/activity-ring` ×3
    - `primitives/css/ui-kit` ×3
    - `primitives/error-boundary` ×2
    - `network/live/live-state.ResourceErrorInline`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/row-actions.RowActions`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `shell/action-bar.ActionBar`
    - `ui/icons.Icon`
  - Exports (types):
    - `HealthInfo`
    - `HealthMark`
    - `HealthReportRow`
    - `HealthState`
    - `HealthStatus`
    - `InfoRow`
    - `SetItem`
    - `SetItemProps`
    - `SetRow`
    - `SetRows`
    - `StatusRow`
  - Exports (values):
    - `HealthLineView`
    - `HealthReport`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --pad-row-x`
    - `ui/tokens/density --pad-row-y`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `apps/deploy/box-link/site-row`
    - `build`
    - `conversations/runtime-sdk`
    - `database/query-deadline`
    - `debug/queue-health`
    - `debug/sentinel/health-row`
    - `infra/deps/pin-drift`
    - `infra/health/connection-row`
    - `infra/host/io-health`
    - `infra/launcher/gateway-drift`
    - `infra/mcp/browser`
    - `infra/mcp/health`
    - `integrations/github-events`
    - `primitives/dom/web-storage/health`
    - `reports/resource-errors`
    - `tasks/worktree-identity`
    - `upstream`
- Exemptions:
  - Exempts itself from: `react-compiler:no-silent-skips` — `web/components/health-row.tsx`, `web/components/status-probes.tsx` (debt)
- Core:
  - Exports (types):
    - `DotMerge`
    - `GlanceProps`
    - `HealthInfo`
    - `HealthLevel`
    - `HealthMark`
    - `HealthMerge`
    - `HealthReportRow`
    - `HealthState`
    - `HealthStatus`
    - `InfoRow`
    - `ReportedStatus`
    - `ReportItem`
    - `RowLevel`
    - `SetItem`
    - `SetItemProps`
    - `SetRow`
    - `SetRows`
    - `SortableRow`
    - `StatusRow`
  - Exports (values):
    - `foldQuietRows`
    - `isPending`
    - `isPulsing`
    - `isTransitioning`
    - `levelOf`
    - `mergeDot`
    - `mergeHealth`
    - `sortRows`
    - `verdictOf`

<!-- AUTOGENERATED:END -->
