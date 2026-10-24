# Drain the `no-pending-data-collapse` BURNDOWN allowlist

## Context

The `live-state/no-pending-data-collapse` lint rule landed on 2026-06-11 with **64
grandfathered files** (~80 collapse sites) on a BURNDOWN allowlist in
`plugins/primitives/plugins/live-state/lint/index.ts`. Every allowlisted site still
collapses a loading resource into a fake default — `r.pending ? [] : r.data`,
`? 0 :`, `? null :`, `? {} :` — at the exact line where "still loading" and
"genuinely empty" are still distinguishable. The consequence is the
wrong-state-while-loading bug class: empty lists, zero counts/badges, missing
chips, "not found" / "no summary yet" placeholders, and (worst) a destructive
delete dialog that hides its sub-page count, all flashing during the load window.

This plan migrates **all 64 files** to the sanctioned readiness-gate patterns and
**empties the allowlist** in a single sweep, so the rule goes fully green and the
idiom can never silently regrow. Patterns and rationale:
`plugins/primitives/plugins/live-state/CLAUDE.md` → "Readiness gates".

## The clean principle (how to migrate, not exempt)

**Gate at the render boundary; never convert the banned ternary into an `if` that
keeps the same fake default.** The lint rule is syntactic (it only catches the
ternary), so `pending ? [] : data` → `if (pending) return []` *passes* the linter
while preserving the exact bug. That is the hacky dodge CLAUDE.md forbids. The test
for a clean fix: after the change, the loading window must render a **distinct**
state (`<Loading/>` / skeleton / `null`-by-design), **or** the default must be
**genuinely correct** while pending (documented). If neither holds, it is still a
collapse.

Sanctioned APIs (all from `@plugins/primitives/plugins/live-state/web`; `Loading`
from `@plugins/primitives/plugins/loading/web`):
`<ResourceView resource={r} fallback={…}>{(data) => …}</ResourceView>`,
`matchResource(r, { ready, pending, error })`,
`useCombinedResources({ a, b })` → `if (all.pending) …`, and `<DataView loading={r.pending} … />`.

## Three migration recipes (decision tree per site)

**Recipe A — component, no hooks after the derive.** Plain early-return.
```tsx
const r = useResource(res);
if (r.pending) return <Loading variant="…" />;   // or return null where a hidden-while-loading chip is correct
const rows = r.data.filter(…);                    // drop the `pending ? [] : data` memo; compute inline
```
The common case. For list/grid surfaces backed by `<DataView>`, pass
`loading={r.pending}` instead of an early-return so the skeleton shows and
`emptyState` only renders on confirmed-empty.

**Recipe B — component with hooks *after* the derive** (`useEditableField`,
`useEffect`, `useState`, `useCallback` — rules-of-hooks forbids early-return before
them). Split outer/inner so the inner only ever sees settled data:
```tsx
function Foo() {
  const r = useResource(res);
  return (
    <ResourceView resource={r} fallback={<Loading />}>
      {(data) => <FooInner data={data} />}
    </ResourceView>
  );
}
function FooInner({ data }: { data: Row[] }) {
  const rows = useMemo(() => derive(data), [data]);   // no pending, no ternary
  // …all the post-derive hooks live here, always with real data
}
```
Both the ternary **and** any now-redundant `if (r.pending) return <Placeholder>`
guard disappear.

**Recipe C — `.ts` hooks (no JSX).** Two sub-cases:
- Empty-while-pending is **observable as wrong UI** → propagate pending: return a
  gateable shape (`{ pending: true } | { pending: false; … }`, or expose the raw
  resource result) and let the JSX consumer gate with Recipe A/B. A minimal
  if-narrowing here only relocates the bug.
- Default is **genuinely correct** while pending → explicit
  `if (r.pending) return <correct default>;` with a one-line comment stating why
  it is not a collapse (e.g. staleness is unknowable mid-load, so `stale=false`).

Multi-resource components use `useCombinedResources({ a, b })` then
`if (all.pending) return <Loading/>` — all-or-nothing, so the view can never paint
from a half-loaded snapshot.

## False positives to verify, not auto-migrate

Two sites the catalog flagged as **already select-carve-out or structurally
guarded** — confirm with the rule's carve-out logic before touching:
- `op-status-banner.tsx` **line 40** (`useTitleBySlug`) uses `useResource(…, { select })`
  → exempt by the rule's select carve-out; the lint flag is on **line 183**
  (`worktreeOpsResource`), which is the one to migrate (Recipe B; guard already at L188).
- `task-card.tsx` **line 59** is a `useActiveDataBinding` result, **not** a resource
  hook — outside the rule. The real sites are L155 / L213 (Recipe A).

## Special-attention sites

- **`delete-page-action.tsx` (L33) — dangerous.** `pending ? 0 : countDescendants(...)`
  hides the "and N sub-pages" warning in a **destructive** confirm dialog. Gate the
  count (Recipe A) and render the delete button disabled-neutral while pending —
  never a 0-default. Highest correctness priority.
- **`.ts` hooks needing pending propagation (Recipe C, sub-case 1):**
  `apps/sonata/playback-history/web/hooks.ts` (`usePlaybackHistoryMap`),
  `apps/sonata/track-mixer/web/hooks.ts` (`useCurrentSongOverrides`),
  `apps/story/marker/web/hooks.ts` (`useStories`),
  `conversations/.../notes/web/internal/use-conversation-note.ts`,
  `floating-bar/web/internal/use-floating-bar-status.ts`,
  `page/.../editor/web/components/page-options.tsx` (`usePageOptions`).
  `story-gallery.tsx` consumes `useStories` — migrate it together with `marker/hooks.ts`.
- **Genuinely-correct default (Recipe C, sub-case 2):**
  `build/web/hooks/use-stale-frontend.ts` (`stale=false` while pending is correct).
- **Multi-site files** (one early-return/inner-split per sub-component):
  `build/web/components/build-popover-content.tsx` (L43/L216/L267),
  `debug/plugins/queue/web/components/queue-view.tsx` (L87/L92/L251/L369),
  `notifications/web/components/bell-button.tsx` (L106/L128),
  `conversations/.../grouped/web/components/grouped-conversation-list.tsx`
  (L94/L164 → `useCombinedResources`).

## Execution — one sweep, parallel Sonnet agents

Migrate all 64 files in this task, then empty the allowlist. Fan out to **Sonnet**
implementation agents grouped by plugin area (each agent gets this doc's recipes +
its file list + the catalog notes). Suggested grouping (each ~10–14 files):

1. **active-data + agents** (9 files) — chips/avatars; several Recipe A, two
   degraded-chip cases (attempt-chip, task-link-chip) render a raw-id fallback
   while pending, keep that as the explicit `pending` branch.
2. **apps (pages, sonata, story, deploy)** (13 files) — includes the `delete-page-action`
   danger site, three `.ts` hooks (Recipe C), and `story-gallery`+`marker` pair.
3. **build + auth + conversations-recover** (8 files) — build-popover multi-site,
   use-stale-frontend (Recipe C-correct), build-info/build-fix not-found split.
4. **conversations/conversation-view** (15 files) — mostly Recipe A jsonl-viewer
   panes/counters; `jsonl-pane` and `ask-user-question-tool-view` are Recipe B;
   `op-status-banner` L183 + carve-out note.
5. **conversations/summary + grouped + debug + fields + notifications + floating-bar**
   (9 files) — grouped-list `useCombinedResources`, queue-view multi-site,
   bell-button multi-site, secret-renderer, use-floating-bar-status (Recipe C).
6. **page + plugin-meta + review + tasks** (10 files) — task chips/graph/list
   Recipe A; several already-guarded (`tasks-list`, `expand-collapse-all-action`,
   `task-description`) → Recipe B/A restructure, not vestigial-ternary patch.

After each agent returns, **remove that file's line from the BURNDOWN array** in
`plugins/primitives/plugins/live-state/lint/index.ts`. When all are migrated the
`ignores` array is empty — delete the empty `ignores` block (or leave `[]` with the
BURNDOWN comment removed).

## Files to modify

- `plugins/primitives/plugins/live-state/lint/index.ts` — empty the allowlist (the goal).
- 64 source files listed in the current allowlist (lines 14–77 of that file).

## Verification

1. **Lint green:** `./equin check type-check` (runs the type-aware ESLint that
   includes `no-pending-data-collapse`) must report **zero** `no-pending-data-collapse`
   violations with the allowlist empty. This is the primary gate — an empty allowlist
   only stays green if every site is genuinely migrated.
2. **Build:** `./equin build` from the worktree (regenerates docs/registries,
   rebuilds, restarts). Must succeed.
3. **Behavioral spot-checks** (Playwright, `http://att-1781208577-waea.localhost:9000`)
   on the highest-visibility surfaces, confirming a loading state (not a wrong empty
   state) during the load window:
   - Bell-button badge (notifications) — no `0`/no-badge flash before count loads.
   - Grouped + welcome conversation lists — skeleton, not "ungrouped"/empty flash.
   - Dependent-count chip / commits chip / event-counter — absent while loading,
     not a `0` chip.
   - `delete-page-action` confirm dialog — sub-page count present (or button
     disabled) before deletion is offered; never a misleading "Delete X?" with no
     count on a page that has children.
   - build-info / agent-report-pane / workflow-node-pane — `<Loading>`, not
     "Run/Event/Step not found", while pending.
4. **Regression scan:** `git diff $(git merge-base HEAD main) -- plugins/primitives/plugins/live-state/lint/index.ts`
   shows the allowlist emptied; no new entries anywhere.
