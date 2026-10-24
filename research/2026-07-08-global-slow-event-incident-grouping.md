# Slow-event incident grouping: co-occurring traces visible as a group

**Date:** 2026-07-08 · **Category:** global (debug/trace) · **Builds on:** [2026-07-08-global-unified-slow-event-tracing.md](./2026-07-08-global-unified-slow-event-tracing.md) §7 (deferred open question)

## Context

One slow user moment mints several **unlinked** traces — a server loader span, a
client element-settle, a page-load — each admitted independently by
`captureTrace`. In **Debug → Slow Events** they land as unrelated rows in the
flat newest-first list, so an investigator has to correlate them by eyeballing
timestamps. There is no way to see "these three traces are the *same* incident."

Every trace already **is** a wall-clock interval: the `snapshot` records
`wallTime` (the ISO trip anchor) and `windowStartMs`/`atMs` (profiler clock),
and `atMs − windowStartMs = max(trigger.durationMs, cfg.windowMs)` is the exact
captured window span. So **time-overlap grouping is computable entirely
read-side** — no new column, no migration, no client incident-id plumbing. This
plan makes co-occurrence visible in two places that share one pure util:

1. **Events list** — an always-on *incident badge*: co-occurring rows get a
   small colored chip with the sibling count; a stable per-incident color makes
   the (already-adjacent, newest-first) rows read as a group at a glance.
2. **Trace detail** — an *"Also in this window"* section listing the sibling
   traces that overlap this trace's window, each a link to its own detail.

**Known caveat (surfaced in the UI, not hidden):** admission rate-limiting
(`cooldownMs` per `kind:label`, global `maxPerMin` 30) means some siblings of a
storm are never persisted, so **groups can be incomplete**. Both surfaces say so.

This is the intended first step from the research doc's §7 open question; only if
time-overlap hints prove insufficient in practice should explicit client
incident-id propagation be considered (still deferred).

---

## The one prerequisite: expose the wall-clock interval in list metadata

The list endpoint today returns 7 flat columns and **never** the snapshot blob
(by design). `createdAt` is the DB `defaultNow()` at *persist* time — skewed
*after* the trip by however long async enrich took (e.g. `contention`'s
`pg_stat_activity` query) — so it is **not** a reliable interval anchor.
`wallTime`/`windowStartMs` live only inside `snapshot`.

**Fix (no migration — the jsonb is already stored):** project two values out of
the existing `snapshot` blob in the list `SELECT`, and add them to the wire
schema. The blob is not returned; only two scalar json extractions are.

### `plugins/debug/plugins/trace/plugins/engine/shared/endpoints.ts`

Add to `TraceListItemSchema`:

```ts
export const TraceListItemSchema = z.object({
  id: z.string(),
  worktree: z.string(),
  triggerKind: z.string(),
  triggerLabel: z.string(),
  durationMs: z.number(),
  thresholdMs: z.number(),
  createdAt: z.string(),
  wallTime: z.string(),      // NEW — ISO trip anchor (snapshot.wallTime); the interval END
  windowSpanMs: z.number(),  // NEW — snapshot.atMs − snapshot.windowStartMs; interval width
});
```

### `plugins/debug/plugins/trace/plugins/engine/server/internal/handlers.ts`

Project both from jsonb (drizzle `sql` tagged expressions over `_traces.snapshot`):

```ts
import { eq, desc, sql } from "drizzle-orm";
// ...
.select({
  id: _traces.id,
  worktree: _traces.worktree,
  triggerKind: _traces.triggerKind,
  triggerLabel: _traces.triggerLabel,
  durationMs: _traces.durationMs,
  thresholdMs: _traces.thresholdMs,
  createdAt: _traces.createdAt,
  wallTime: sql<string>`${_traces.snapshot} ->> 'wallTime'`,
  windowSpanMs: sql<number>`
    (${_traces.snapshot} ->> 'atMs')::float8
    - (${_traces.snapshot} ->> 'windowStartMs')::float8`,
})
```

Map them through in the `items` projection. `windowSpanMs` is the **exact
captured window** (robust to `cfg.windowMs` changing over time — it comes from
the per-row snapshot, not current config). No index needed — the list is a
`LIMIT 200` newest-first scan already; the json extraction is on the returned
rows only.

> Both new fields are pure reads off already-persisted data, so **existing rows
> work immediately** (every persisted snapshot has `wallTime`/`atMs`/
> `windowStartMs` — `v: 2`). No backfill.

---

## The shared read-side util

### `plugins/debug/plugins/trace/plugins/pane/web/internal/incidents.ts` (new)

Pure function — no React, no IO. Both the list and the detail import it. Interval
per trace: `end = Date.parse(wallTime)`, `start = end − windowSpanMs`.

```ts
export interface IncidentInfo {
  incidentId: number;   // stable index within this result set
  size: number;         // # traces in the incident (≥1)
  colorIndex: number;   // incidentId % PALETTE_LEN, for a stable per-incident tint
}

// Sweep-union of overlapping wall-clock intervals (transitive: A∩B, B∩C ⇒ one
// incident even if A∌C — a connected chain of overlapping activity is one
// incident). O(n log n). Returns a lookup keyed by trace id.
export function groupIncidents(
  items: { id: string; wallTime: string; windowSpanMs: number }[],
): Map<string, IncidentInfo>;

// Overlap test for the detail pane's sibling list (excludes self by id):
export function overlaps(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): boolean; // a.startMs <= b.endMs && b.startMs <= a.endMs
```

Algorithm (`groupIncidents`): map to `{id, startMs, endMs}`; sort by `startMs`
(stable); sweep maintaining `curEnd`; `startMs <= curEnd` → join current incident
(`curEnd = max(curEnd, endMs)`), else open a new incident. Two passes: first
assigns each id an incident index and tallies sizes, second stamps `size` +
`colorIndex`. Only incidents with `size ≥ 2` matter to the UI, but the map
carries every id so callers don't special-case.

Because a fixed-width window (default ≥10s) coalesces anything tripping within
~10s of a neighbor, a sustained slow period chains into **one large incident** —
that is correct ("it was one bad stretch"); documented, and a bounded-gap variant
is a config-free future tweak if it over-groups.

### `plugins/debug/plugins/trace/plugins/pane/web/internal/incidents.test.ts` (new, bun:test)

Co-located pure-logic test (per testing rules — `bun:test`, next to source, **not**
under `__tests__/`). Cases: single trace → size 1; two overlapping → shared
incidentId, size 2; disjoint → distinct incidents; **transitive chain** (A∩B,
B∩C, A∌C) → one incident of size 3; boundary touch (`aEnd === bStart`) → grouped;
stable ids across input order (shuffle → same grouping).

Run: `bun test plugins/debug/plugins/trace/plugins/pane/web/internal/incidents.test.ts`

---

## Surface 1 — Events list incident badge

### `plugins/debug/plugins/trace/plugins/pane/web/components/events-view.tsx`

- Compute the incident map once from the fetched rows:
  `const incidents = useMemo(() => groupIncidents(rows), [rows]);`
- Add a new **"Incident"** `FieldDef<TraceListItem>` (place it right after
  `createdAt`, before `triggerKind`), `width: "4rem"`, `align: "start"`,
  non-sortable:
  - `value: (r) => incidents.get(r.id)?.size ?? 1` (so the column is at least
    numerically meaningful),
  - `cell: (r) => { const info = incidents.get(r.id); return info && info.size > 1
    ? <IncidentBadge info={info} /> : null; }`.
- `IncidentBadge` (small internal component, `pane/web/components/incident-badge.tsx`
  or inline): a `Badge` / colored dot + count (e.g. a filled dot in the
  incident's palette color + `×{size}` mono), wrapped in a `title`/tooltip:
  *"{size} traces co-occur in this ~{Math.round(windowSpanMs/1000)}s window —
  groups may be incomplete (siblings can be rate-limited)."* Use a small fixed
  palette of Tailwind tint classes indexed by `info.colorIndex` (keep it in
  `internal/incidents.ts` or a sibling `incident-palette.ts` so the color mapping
  is single-sourced with the util's `colorIndex`).

Rows are already sorted newest-first (`desc(createdAt)`), and co-occurring traces
persist within a small span, so same-incident rows are adjacent — the shared tint
makes them read as a visual cluster with **zero view-mode change**. Solo traces
render nothing in the column (no noise).

> Reuse existing primitives: `Badge` (`primitives/css/badge/web`) and/or
> `StatusDot` (`primitives/css/status-dot/web`) rather than hand-rolled markup.

---

## Surface 2 — Trace detail "Also in this window"

### `plugins/debug/plugins/trace/plugins/pane/web/components/trace-detail.tsx`

`TraceDetail({ id })` already loads the full snapshot via `getTrace`. Add a
sibling fetch and an overlap section:

- `const { data: list } = useEndpoint(listTraces, {});` (the cheap 200-newest
  metadata — same call the list tab uses; deduped by the endpoint layer, so no
  double network cost when both are open).
- Compute this trace's interval from its **own snapshot** (exact):
  `end = Date.parse(snapshot.wallTime)`, `start = end − (snapshot.atMs −
  snapshot.windowStartMs)`.
- `siblings = (list?.items ?? []).filter(t => t.id !== id && overlaps(self, {
  startMs: Date.parse(t.wallTime) − t.windowSpanMs, endMs: Date.parse(t.wallTime) }))`.
- Render an **"Also in this window ({n})"** section directly under the header
  (`<div className="border-b px-lg py-sm">` region, after
  `<Trace.TriggerSummary.Dispatch>`), hidden entirely when `siblings.length === 0`
  (solo trace). Each sibling is a compact clickable row / `LinkChip`:
  - trigger-kind `Badge` (reuse `triggerVariant` from `../internal/trigger-meta`),
  - truncating `triggerLabel`,
  - a wall-offset hint (`+{((Date.parse(t.wallTime) − end)/1000).toFixed(1)}s`
    relative to this trip, signed),
  - `onClick={() => openPane(traceDetailPane, { id: t.id }, { mode: "push" })}`
    (needs `useOpenPane()` — import from `primitives/pane/web`, as `events-view`
    already does).
- Section subtitle / tooltip carries the same incompleteness caveat as the badge.

This gives the investigator a one-click hop between the co-occurring traces of a
single incident, from inside the deep-dive view.

> Threading: `TraceDetail` currently returns `<TraceGantt snapshot={data.snapshot} />`
> directly. Add the siblings section in `TraceDetail` (it has `id` + the list) and
> pass nothing extra to `TraceGantt`, OR render siblings inside `TraceGantt`'s
> header block — either is fine; keep the Gantt component focused and put the
> siblings section in `TraceDetail` above `<TraceGantt>` for separation.

---

## Boundaries & reuse check

- `groupIncidents`/`overlaps` live in `pane/web/internal/` — both consumers
  (`events-view`, `trace-detail`) are in the **same** `pane` plugin, so no
  cross-plugin import. ✅
- `TraceListItem` (with the two new fields) flows `engine/shared → engine/web →
  pane` as it already does. Pane never touches `engine/shared` directly. ✅
- No new endpoint, no new slot, no new table/column. The only server change is
  two extra `sql` projections in an existing handler + two schema fields. ✅
- Reuses `Badge`, `StatusDot`, `RelativeTime`, `triggerVariant`, `useOpenPane`,
  `useEndpoint`, `DataView` `FieldDef` — no new primitives. ✅

## Files touched

| File | Change |
|---|---|
| `engine/shared/endpoints.ts` | +2 fields on `TraceListItemSchema` |
| `engine/server/internal/handlers.ts` | project `wallTime` + `windowSpanMs` from jsonb in `handleListTraces` |
| `pane/web/internal/incidents.ts` | **new** — `groupIncidents`, `overlaps`, palette |
| `pane/web/internal/incidents.test.ts` | **new** — bun:test |
| `pane/web/components/events-view.tsx` | incident map + "Incident" column + badge |
| `pane/web/components/incident-badge.tsx` | **new** (or inline) — the badge |
| `pane/web/components/trace-detail.tsx` | "Also in this window" siblings section |
| `pane/CLAUDE.md` (autogen block regenerates on build) | prose note if warranted |

No docs/registry drift beyond the autogen blocks that `./equin build`
refreshes.

---

## Verification (end-to-end)

1. **Unit:** `bun test plugins/debug/plugins/trace/plugins/pane/web/internal/incidents.test.ts`
   — grouping/overlap/transitive/stability all green.
2. **Build:** `./equin build` (from this worktree) → green; then
   `./equin check` (boundaries, type-check, plugins-doc-in-sync).
3. **Generate co-occurring traces** (make several trip within one window so their
   intervals overlap). The `cooldownMs` is *per `kind:label`*, so distinct labels
   co-occur freely:
   ```
   # three distinct labels in quick succession → overlapping windows, one incident
   for i in 1 2 3; do
     curl -s -XPOST http://<wt>.localhost:9000/api/debug/trace/test-trigger \
       -H 'content-type: application/json' \
       -d "{\"ms\": 1500, \"label\": \"incident-demo-$i\"}"
   done
   ```
   (Fall back to `benchmark_boot` MCP + Debug → Live-State Emit for organic
   spans if needed.)
4. **Confirm the wire enrichment:**
   `mcp__singularity__query_db` →
   `SELECT id, snapshot->>'wallTime' AS wall, (snapshot->>'atMs')::float8-(snapshot->>'windowStartMs')::float8 AS span FROM traces ORDER BY created_at DESC LIMIT 5;`
   — matches what `GET /api/traces` now returns (curl it, assert `wallTime` +
   `windowSpanMs` present).
5. **List UI:** `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/debug/traces --out /tmp/incidents`
   — the three demo rows share an incident badge color + `×3`; a solo/older row
   has no badge.
6. **Detail UI:** open one demo trace
   (`--url .../debug/traces/x/<id> --out /tmp/incident-detail`) — the "Also in
   this window (2)" section lists the two siblings with signed wall offsets;
   clicking one navigates to its detail. Open an isolated trace → section absent.

---

## Risks / open questions

- **Incomplete groups (documented):** rate-limited siblings never persist, so a
  badge count is a *lower bound*. Surfaced in both tooltips — honest, not hidden.
- **Transitive over-grouping** of a long slow stretch into one incident — treated
  as correct; bounded-gap coalescing is a later config-free option.
- **`createdAt` vs `wallTime`:** the badge/section use `wallTime` (exact trip
  anchor), never `createdAt` (persist-skewed) — deliberately, to avoid
  enrich-latency error in overlap detection.
- **Still deferred:** true client incident-id propagation (§7). This read-side
  grouping is the first step; only escalate if time-overlap proves insufficient.
