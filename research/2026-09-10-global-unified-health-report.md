# Unified health report

## Context

The top-right of the tab bar carries three overlapping status signals today:

- a green "connected" dot (`infra/health` → `HealthDot`, an `ActionBar.Item`),
- the worktree label (`apps/agent-manager/plugins/worktree-switcher`, an `ActionBar.Item`),
- the sparkle glyph with its own aggregated dot (`shell/global-action-bar` →
  `StatusGlyph` + `useActionBarStatus`: connection + stale tab + unread notifications).

They disagree about what green means, and none of them is extensible. The page
"Unified health report" (`block-ec45b8a9-c662-4c65-aaf3-996f5f039a6a`) asks for
one dot that merges health contributions registered by any plugin, opening a
human-readable, high-level report. Fine-grained debugging stays in Debug →
Reports / Timeline (the "centralized reporting" page).

Mock: prototype `proto-1789050533-m1tj`.

### Decisions taken with the user

| Topic | Decision |
|---|---|
| Button | A dot only. A count joins it (and it tints) when rows are not green. No text. |
| Pending | Grey, pulsing, until every row has reported. |
| Worktree / task name | Leaves the bar; becomes the report's first row (informational, never moves the dot). |
| Sparkle glyph | Removed with its dot. The health dot takes its place, in both pinned and unpinned modes. |
| Deployment / Builds | Stays a separate button. Not a row. |
| Reports / notifications | Skipped: the bell already covers it. |
| Job queue row | Follow-up task `task-1789057838725-i6393i` (filed, depends on this task). Stays in the mock. |
| Host row | Follow-up task (to file at implementation start). No push source exists today. |

So v1 ships: the slot, the dot, the popover, and two rows — **Worktree** and
**Connection** — plus the removals.

## UI

- **Button**, leading item of the global action bar (where the sparkle sits):
  `ok` → green dot only; `attention` / `critical` → amber / red dot + count of
  non-green rows, tinted pill; `unknown` → grey pulsing dot. Pulses also while any
  row is `transitioning` (reconnecting). Tooltip and `aria-label` = the verdict.
- **Click** opens a popover (`InlinePopover`, `align="end"`):
  - Header: big dot + verdict — "All systems normal" / "Checking…" / the one
    non-green row's summary / "N things need attention".
  - Rows: info rows first (worktree), then status rows sorted worst-first,
    ties by `order`. Each status row: dot, title, one-line summary, optional
    always-visible glance, optional trailing actions, optional expandable detail
    (chevron exists iff a detail exists — detail-sections' rule).
  - No footer. The mock's "Details in Debug" links move onto the rows they
    explain (via `actions`), so the report never names a contributor's pane.
- **Unpinned bar**: the dot is the `FloatingAction` trigger — hover expands the
  bar, click opens the report (the trigger is ordinary DOM; clicks work).

## Architecture

### New plugin: `plugins/shell/plugins/health-report`

Slot owner + renderer. Knows no contributor (collection-consumer separation).

```
shell/plugins/health-report/
  core/
    index.ts            # barrel: types + pure functions
    merge.ts            # mergeHealth, verdictOf, sortRows (pure)
    merge.test.ts       # bun:test
  web/
    index.ts            # barrel: { HealthReport slots, HealthReportButton }
    slots.ts            # HealthReport.Row = defineSlot<HealthReportRow>()
    internal/store.ts   # defineScopedStore: Record<rowId, HealthStatus>
    components/
      health-report-button.tsx   # provider + probes + dot + popover
      status-probes.tsx          # one probe component per status row
      health-report-panel.tsx    # header + rows
      health-row.tsx             # row chrome (status | info)
    __tests__/health-report.test.tsx  # jsdom
  CLAUDE.md
```

### Contribution contract (`web/slots.ts`, types in `core/`)

```ts
type HealthState = "ok" | "attention" | "critical";

// What a status row's hook returns. "unknown" is a state to render (grey),
// never a stand-in for ok — per "not-known-yet is a state".
type HealthStatus =
  | { state: "unknown"; summary?: string }
  | { state: HealthState; summary: string; transitioning?: boolean };

interface RowCommon {
  id: string;
  order: number;                 // tie-break among rows of equal severity
  actions?: ComponentType;       // trailing controls (copy, "Open task", "Open queue")
}

interface StatusRow extends RowCommon {
  kind: "status";
  title: string;
  useStatus: () => HealthStatus; // called ALWAYS (colours the dot while closed)
  glance?: ComponentType;        // under the summary while the report is open (queue bars)
  component?: ComponentType;     // expandable detail, mounted only when expanded
}

interface InfoRow extends RowCommon {
  kind: "info";
  icon: ComponentType<{ className?: string }>;
  useInfo: () => { title: string; summary: string };
  glance?: never;
  component?: never;
}

type HealthReportRow = StatusRow | InfoRow;
export const HealthReport = { Row: defineSlot<HealthReportRow>() };
```

- ~~A **plain `defineSlot`**, not `defineRenderSlot`: the report owns the order
  (info → severity → `order`), so reorder middleware would fight it, and a render
  slot would owe a reorder config for nothing. Precedent: `Runs.Kind`.~~
  **Superseded (2026-10-25,
  [`2026-10-25-global-no-ordering-numbers-on-slots.md`](./2026-10-25-global-no-ordering-numbers-on-slots.md)):**
  the premise was wrong — "the report owns the order" is exactly what a reorder
  config layout is. `HealthReport.Row` is a render slot the report reads with
  `useSlotOrder` and draws itself; rows carry no `order`, and `defineSlot`
  now rejects a numeric one.
- Info rows are a type-level distinction: they cannot declare a state, so they
  structurally cannot move the dot (rung 2).
- `component` is the sealed field → rendered via `renderIsolated` (error
  boundary for free). `glance` / `actions` are rendered inside an
  `ErrorBoundary` by the row chrome.
- The glance/detail/`actions` extension points exist for the queue follow-up;
  v1's worktree row uses `actions`, and the jsdom test exercises glance/detail.

### Merge (`core/merge.ts`, pure)

```ts
mergeHealth(statuses: ReadonlyArray<HealthStatus | undefined>)
  → { state: HealthState | "unknown"; count: number; transitioning: boolean }
```

- `undefined` = a registered status row whose probe has not reported yet → unknown.
- Precedence: `critical > attention > unknown > ok`. Unknown outranks ok, so the
  dot cannot claim green before every row has reported.
- `count` = rows in `attention | critical`. `transitioning` = any row transitioning.
- `verdictOf` and `sortRows` live beside it. All three are bun-tested.

### Host mechanics (`HealthReportButton`)

1. Wraps itself in the scoped-store provider (`primitives/scope/plugins/scoped-store`).
2. `StatusProbes`: `HealthReport.Row.useContributions()`, filter `kind: "status"`,
   render one `<StatusProbe key={id} useStatus={…}/>` per row. Each probe calls
   its hook unconditionally and publishes into the store in an effect; unmount
   removes its entry. This is the detail-sections split (one component per
   contribution ⇒ rules-of-hooks clean). Each probe sits in an `ErrorBoundary`
   whose fallback publishes `{ state: "unknown", summary: "This check crashed" }`
   — a crashing check greys the dot, never greens it, and is reported through the
   boundary's existing sink.
3. The dot reads `mergeHealth` through a selector (re-render bailout).
4. The popover panel renders rows from contributions + store. Info rows call
   `useInfo` in their own row component (only while open). The row list is a
   `Row`-style map of slot contributions — transient chrome, annotated with the
   `data-view/no-adhoc-row-list` disable (precedent: `quick-find-dialog.tsx`).
   Expandable rows use `primitives/collapsible`.
5. Deferred tiers adding a row later simply add a probe; no closed-list assumption.

Probes mount wherever the button mounts. The two action-bar hosts are mutually
exclusive (pin), so there is always exactly one live set of probes.

### Placement: `shell/plugins/global-action-bar`

- `FloatingActionBarHost`: `trigger={<HealthReportButton />}` replaces `StatusGlyph`.
- `DockedActionBarHost`: `<HealthReportButton />` replaces the leading `StatusGlyph`.
- Delete `StatusGlyph`, `internal/use-action-bar-status.ts`, and the `build` /
  `shell/notifications` imports that only it needed. Rewrite the CLAUDE.md prose
  (the "status hook keeps the graph acyclic" paragraph no longer applies).
- The stale-tab and unread-notification signals stop feeding any dot. This is the
  user's decision: the Builds button and the bell already show them.

## v1 contributions

### Connection — `plugins/infra/plugins/health/web`

Replace the `HealthDot` `ActionBar.Item` with:

```ts
HealthReport.Row({ kind: "status", id: "connection", title: "Connection",
                   order: 10, useStatus: useConnectionHealth })
```

`useConnectionHealth` reshapes the existing `aggregateStatus` / `tooltipLabel`
logic over `useNotificationsChannelStatuses()`:

| worktree / central sockets | state | summary |
|---|---|---|
| both `open` | ok | Server and central connected |
| any `closed` | critical | Server disconnected / Central disconnected |
| any `reconnecting` / `connecting` | attention, `transitioning` | Reconnecting to server… |

Delete `components/health-dot.tsx`. `ReconnectWatcher`, `WedgeWatchdog` and
`getHealth` are untouched.

### Worktree — new `plugins/tasks/plugins/worktree-identity/web`

Moves the logic out of `worktree-dropdown.tsx`, which its own index already
flagged as "no longer agent-manager-specific". Living outside `apps/…` also makes
it eager structurally (eager-tier rule 1), so the row is present at first paint.

```ts
HealthReport.Row({ kind: "info", id: "worktree", order: 0, icon: MdAccountTree,
                   useInfo: useWorktreeIdentity, actions: WorktreeActions })
```

- Namespace from `namespaceFromHost(window.location.host)`; `null` → "Local dev".
- Title: the linked task's title, else the namespace. Summary: namespace ·
  "agent worktree" / "main checkout" / the composition name.
- Task lookup: same join the label does today over `attemptsResource` +
  `tasksResource` (both legacy unbounded but boot-critical and already resident —
  no new read, no new resource). Fix the composition case: match on the
  *checkout* half of `<composition>.<checkout>`, not the whole namespace
  (today's `endsWith("/" + ns)` misses `sonata.att-…`). If namespace core has no
  parser for that, add `checkoutOfNamespace` next to `namespaceFor`.
- `WorktreeActions`: `CopyButton` (`primitives/copy-to-clipboard`) with the
  namespace, and "Open task" → `navigate(taskDetailPane.link(agentManagerApp, { taskId }))`
  when a task is linked.

Then delete `plugins/apps/plugins/agent-manager/plugins/worktree-switcher`.

## Removals and fix-ups

- `config/shell/action-bar/item.jsonc` and `item.origin.jsonc`: drop
  `apps.agent-manager.worktree-switcher:worktree-switcher` and
  `infra.health:health-dot` (stale ids are silently skipped at render, but the
  committed order should not name dead contributions). Follow the file's own
  `@hash` maintenance, don't hand-edit the hash.
- `plugins/framework/plugins/web-sdk/core/load-tiers.test.ts`: the
  "worktree-switcher is pinned eager via its ActionBar.Item contribution" case
  names a deleted plugin. Repoint it at another `ActionBar.Item`-pinned app
  plugin if one exists, else delete the case.
- Autogenerated registries, tiers and CLAUDE.md reference blocks regenerate on
  `./equin build`.

## Follow-ups

1. **Job queue row** — `task-1789057838725-i6393i`, already filed. Uses `glance`
   (per-class fill bars), `component` (jobs explaining the colour) and `actions`
   ("Open queue" → Debug → Queue). ~~Its data is push-based already
   (`jobsListResource`, `deadJobsResource` in `debug/queue`).~~ Correction: it
   was not — `jobsListResource` re-read up to 500 rows every 3 s while observed.
   The row's design adds a push signal (the jobs slot ledger) and its own
   bounded resource instead:
   [`2026-09-11-global-job-queue-health-row.md`](2026-09-11-global-job-queue-health-row.md).
2. **Host row** — file as a follow-up task at implementation start. Needs a push
   source: the host sampler is main-only and writes a log channel, the Debug
   Health pane polls, and the duress latch / contention snapshot are server-only.
3. Not in scope: live-state "wedged" as a readable signal (today only a toast +
   report inside `WedgeWatchdog`); agent/MCP access to the merged report.

## Verification

1. `./equin test plugins/shell/plugins/health-report` —
   - bun: `mergeHealth` precedence, unknown-outranks-ok, count, transitioning;
     `sortRows` (info first, worst first, stable by `order`); `verdictOf` cases.
   - jsdom: fake contributions → dot tone/count/pulse; a row that has not
     reported ⇒ grey; a throwing `useStatus` ⇒ unknown, siblings unaffected;
     detail mounted only after expanding; info rows never change the count.
2. `./equin build` (background), then check the deploy receipt.
3. Screenshots with the e2e harness, pinned (default) state:
   ```bash
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --click "All systems normal" --out /tmp/health
   ```
   Confirm: dot only in the bar, no worktree label, no sparkle; the report shows
   the worktree row (task title, copy, Open task) and a green Connection row.
   Repeat with `--color-scheme dark`.
4. Unpin the bar in the running app: the dot sits alone in the corner, hover
   expands the bar, click opens the report.
5. Kill the socket path (restart the backend via a rebuild) and watch the dot go
   amber/pulsing then green, matching the Connection row.
6. `./equin check` — boundaries (no cycles: health-report imports no
   contributor), `eager-tier-in-sync`, `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, type-check/lint.
