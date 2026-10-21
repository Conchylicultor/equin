# health-report

One dot that answers "is everything fine?", merged from health rows any plugin
registers, opening a short human-readable report. Fine-grained debugging stays
in Debug → Reports / Timeline; this is the high-level summary. Design:
[`research/2026-09-10-global-unified-health-report.md`](../../../../research/2026-09-10-global-unified-health-report.md).

This plugin owns the `HealthReport.Row` slot and renders it. It knows no
contributor: every row, including the worktree identity and the connection, is
a contribution from the plugin that owns that fact.

## Contributing a row

Two kinds, and the kind is the whole contract:

```ts
import { HealthReport } from "@plugins/shell/plugins/health-report/web";

// A status row: has a state, feeds the dot.
HealthReport.Row({
  kind: "status",
  id: "connection",
  title: "Connection",
  order: 10,
  useStatus: useConnectionHealth, // () => HealthStatus
  actions: OpenDebugHealth,       // optional trailing controls
  glance: QueueBars,              // optional, under the summary
  component: QueueDetail,         // optional expandable detail
});

// An info row: says where you are, never how healthy it is.
HealthReport.Row({
  kind: "info",
  id: "worktree",
  order: 0,
  icon: MdAccountTree,
  useInfo: useWorktreeIdentity,   // () => { title, summary }
  actions: WorktreeActions,
});
```

- **`useStatus` runs all the time**, report open or not — it is what colours the
  dot. Keep it a cheap read of state that is already resident. It returns
  `{ state: "ok" | "attention" | "critical", summary, transitioning? }`,
  `{ state: "unknown", summary? }` or `{ state: "not-applicable", summary }`.
- **`unknown` is a state, not a stand-in.** Without a summary it means "not
  known yet": grey and pulsing, and the report says "Checking…". With one it
  means "known to be unreadable right now" ("Unknown while disconnected"): grey
  and still. Never return `ok` because you do not know yet.
- **`not-applicable` is "this check does not exist here"**, not "can't read
  it": a machine-only check under a host without the computer (its read is
  `unavailable` — return `{ state: "not-applicable", summary: result.message }`).
  The merge leaves it out, so it neither greys nor greens the dot; the row is
  listed last with a hollow dot and its summary saying why.
- **Info rows cannot move the dot.** They have no field to declare a state
  through, so this holds by construction. Their `useInfo` runs only while the
  report is open.
- **The chevron exists iff a `component` does** (detail-sections' rule). The
  detail is mounted only while expanded. `glance` sits inside the row's click
  target when the row is expandable, so it must be presentational — controls go
  in `actions`. It gets `expanded` (`GlanceProps`), so it can show less while
  the row is collapsed.
- **Point at your own pane from `actions`.** The report has no footer and never
  names a contributor's pane.

## Merge

`mergeHealth` (`core/merge.ts`, pure, bun-tested): precedence
`critical > attention > unknown > ok`, so the dot cannot claim green before
every status row has reported. `count` is the rows in attention or critical.
`not-applicable` rows are skipped, exactly as if unregistered.
The dot pulses while any row is not known yet or is `transitioning`.

**Zero rows is `ok`** ("All systems normal"): with nothing registered there is
nothing that could be wrong and nothing pending. The report then shows only its
header.

The verdict (`verdictOf`) is the header text, the button's tooltip and its
accessible name: "All systems normal", "Checking…", the one non-green row's own
summary, or "N things need attention". When every unknown row has said why it
is unknown, the verdict gives that reason instead of "Checking…".

**Quiet rows fold into one card** (`foldQuietRows`, pure, bun-tested): a
status row with nothing beyond its summary (no `glance`, `component` or
`actions`) that is `ok` only says "fine", so two or more of them collapse into
one card — their titles, "All normal" — that lists each when expanded. A row
leaves the card the moment it is not `ok`, so a problem is never behind a
chevron. The rule reads only the row's shape and state, never its id.

Row order (`sortRows`): info rows first, then status rows worst-first
(`not-applicable` last), ties by
`order`, then registration order. This is why the slot is a plain `defineSlot`
and not a render slot: the report owns the order, so reorder middleware would
only fight it.

## Host mechanics

`HealthReportButton` owns a scoped store (`Record<rowId, HealthStatus>`) and
mounts one headless probe per status row. Each probe calls its row's hook
unconditionally (one component per contribution, so every hook call is
rules-of-hooks clean) and publishes into the store; unmounting removes the
entry. The dot reads the merge through a selector, so it re-renders only when
what it shows changes.

A probe whose hook throws is caught by its own boundary, which publishes
`{ state: "unknown", summary: "This check crashed" }` — a crashing check greys
the dot, never greens it — and files the crash through the error-boundary
plugin's `boundaryReportSink`, like every other boundary. The panel's rows, and
each row's `glance` / `actions`, sit in `PluginErrorBoundary`s; the `component`
detail is rendered through `renderIsolated`.

**Mount exactly one button per page.** Probes live wherever the button lives.
`global-action-bar` places it in both of its hosts, which are mutually exclusive
(the pin), so there is always one live set of probes.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Unified health report: one dot merging every HealthReport.Row contribution (critical > attention > unknown > ok, with a count of rows needing a look), opening a popover that lists info rows first and status rows worst-first. Owns the slot and the HealthReportButton; knows no contributor.
- Web:
  - Slots: `HealthReport.Row`
  - Slot contributors:
    - `HealthReport.Row` ← `conversations.runtime-sdk`
    - `HealthReport.Row` ← `database.query-deadline`
    - `HealthReport.Row` ← `debug.queue-health`
    - `HealthReport.Row` ← `debug.sentinel`
    - `HealthReport.Row` ← `infra.health`
    - `HealthReport.Row` ← `infra.mcp.browser`
    - `HealthReport.Row` ← `primitives.dom.web-storage.health`
    - `HealthReport.Row` ← `reports.resource-errors`
    - `HealthReport.Row` ← `tasks.worktree-identity`
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/collapsible` ×4
    - `primitives/css/activity-ring` ×3
    - `primitives/css/ui-kit` ×3
    - `primitives/error-boundary` ×2
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/row-actions.RowActions`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `primitives/slot-render.renderIsolated`
    - `ui/icons.Icon`
  - Exports (types):
    - `HealthInfo`
    - `HealthReportRow`
    - `HealthState`
    - `HealthStatus`
    - `InfoRow`
    - `StatusRow`
  - Exports (values):
    - `HealthReport`
    - `HealthReportButton`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --pad-row-x`
    - `ui/tokens/density --pad-row-y`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `conversations/runtime-sdk`
    - `database/query-deadline`
    - `debug/queue-health`
    - `debug/sentinel`
    - `infra/health`
    - `infra/mcp/browser`
    - `primitives/dom/web-storage/health`
    - `reports/resource-errors`
    - `shell/global-action-bar`
    - `tasks/worktree-identity`
- Core:
  - Exports (types):
    - `GlanceProps`
    - `HealthInfo`
    - `HealthLevel`
    - `HealthMerge`
    - `HealthReportRow`
    - `HealthState`
    - `HealthStatus`
    - `InfoRow`
    - `ReportedStatus`
    - `ReportItem`
    - `RowLevel`
    - `SortableRow`
    - `StatusRow`
  - Exports (values):
    - `foldQuietRows`
    - `isPending`
    - `isPulsing`
    - `isTransitioning`
    - `levelOf`
    - `mergeHealth`
    - `sortRows`
    - `verdictOf`

<!-- AUTOGENERATED:END -->
