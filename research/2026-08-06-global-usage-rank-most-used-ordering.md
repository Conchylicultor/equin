# Most-used ordering for prompt templates (`usage-rank` primitive)

## Context

The prompt-template chips in the conversation prompt editor are expected to show
the most-used templates first. They don't — and can't, because **nothing records
that a template was ever used**. `FloatingTemplateChips`
(`plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`)
renders `templates` in raw config-array order and pins `templates.slice(0, pinnedCount)`.
The only way that order ever changes today is dragging rows in the config editor.

So the visible order is whatever the user hand-authored months ago, not what they
actually reach for. The fix needs a usage signal, a place to keep it, and an
ordering rule that doesn't move a chip out from under the cursor mid-click.

**Outcome:** the pinned strip becomes the user's genuine top-N, kept fresh
automatically, and stays visually stable while they work inside one conversation.

### The constraint that shapes the design

Usage counts **cannot live in config**:

- `forkConfig` (`plugins/config_v2/server/internal/fork.ts`) is a one-time `cp -r`
  of `~/.singularity/config/singularity/` into each new worktree. It never syncs
  back, so per-worktree counts would fragment across the ~137 worktree config dirs.
- `listField` no longer has a `rank`. `normalizeCollectionItems`
  (`plugins/config_v2/server/internal/registry.ts`) treats **array position** as
  canonical and strips the legacy `rank` key the current file still carries. So
  "reordering" in config means rewriting the array — which also churns the
  deterministic `auto-${hash([index, content])}` ids it synthesizes for id-less
  rows. Config must stay the *authored* order; usage order is derived at render.

Decision: a separate DB-backed store, sorted at render time, config untouched.

## Approach

A generic **`plugins/primitives/plugins/usage-rank/`** primitive (namespace + key →
frecency rollup), consumed by `prompt-templates`. Only `prompt-templates` gets
wired now; `launch-prompts`, the `preprompts` library (whose config comment already
notes it "mirrors the prompt-templates config"), and the command palette can adopt
later in a few lines each.

Mirror **`plugins/apps/plugins/sonata/plugins/playback-history/`** — the same
feature already working for songs (atomic increment, live rollup, sort by it). Copy
its shape; deviate only where noted below.

### Storage: per-worktree DB

Counts land in the DB of whichever backend served the page. The user drives
conversations from `equin.localhost:9000`, so the **main** DB accumulates the
real signal; a new worktree inherits a snapshot at fork time. This is the
idiomatic path — atomic upsert, change-feed recompute, live resource for free.

### Scoring: frecency (decayed count)

Raw counts ossify — a template used heavily last year outranks one used weekly
now, forever. Instead, on each use decay the stored score to *now* and add 1:

```
score = score * 0.5^(Δt / HALF_LIFE) + 1
```

with `HALF_LIFE = 30 days`. Comparison at render must **also** decay to now,
otherwise items with different `lastUsedAt` are compared unfairly. Both are O(1) —
no event log, one row per key.

### Reorder timing: frozen per conversation

The order is snapshotted and only re-derived when the conversation changes (or the
template set changes). Within one conversation the chips never move, so muscle
memory holds and clicking two in a row is not a guessing game; habits still surface
within minutes.

## Files

### New: `plugins/primitives/plugins/usage-rank/`

Precedent for a `primitives/*` plugin owning its own table: `primitives/trash`
(`trash_entries`), `primitives/data-view/custom-columns` (`data_view_custom_values`).

**`core/index.ts`** — web-safe, no drizzle:

- `usageKey(namespace, key)` → `` `${namespace}:${key}` `` — the single-column PK.
  (A composite `(namespace, key)` PK is not an option: `point.by` **is** the
  identity pk and must be one column.)
- `UsageStatSchema` = `{ usageKey, namespace, score, useCount, lastUsedAt }`.
- `usageStatsResource` = `pointQueryResourceDescriptor<UsageStat>("usage-stats", UsageStatSchema, "usageKey")`.
  **Point, not push** — bounded membership, O(subscribed ids). Do not copy
  playback-history's unbounded full-table push resource; CLAUDE.md marks that form
  legacy-pending-migration.
- `recordUsage` = `defineEndpoint({ route: "POST /api/usage-rank/record" })`, body
  `{ namespace, key }`.
- `HALF_LIFE_MS`, `decayedScore(stat, now)`, and
  `sortByUsage(keys, statsByKey, now)` — pure, **stable**: decayed score desc,
  ties and never-used keys falling back to the incoming (config) order.

**`server/internal/tables.ts`** — a plain `pgTable("usage_stats", …)`. No
`defineExtension`: that requires a parent `pgTable` + FK, and templates are config
items with no DB row to hang off.

```ts
usageKey    text primary key      // `${namespace}:${key}`
namespace   text not null
score       double precision not null default 0
useCount    integer not null default 0
lastUsedAt  timestamptz not null
```

**`server/internal/routes.ts`** — one atomic upsert, no read-modify-write race
(mirrors `playback-history/server/internal/routes.ts`):

```sql
INSERT INTO usage_stats (usage_key, namespace, score, use_count, last_used_at)
VALUES ($key, $ns, 1, 1, now())
ON CONFLICT (usage_key) DO UPDATE SET
  score = usage_stats.score
          * pow(0.5, EXTRACT(EPOCH FROM (now() - usage_stats.last_used_at)) * 1000 / $halfLifeMs)
          + 1,
  use_count = usage_stats.use_count + 1,
  last_used_at = now();
```

**`server/internal/resource.ts`** — `windowQueryResource(usageStatsDescriptor, { from: t, point: { by: t.usageKey } })`.
Shape it exactly like `conversations/conversation-category/server/internal/resource.ts`.

**`server/internal/retention.ts`** — `defineRetention` (`@plugins/infra/plugins/retention/server`)
nightly sweep on `lastUsedAt` older than 1 year, so keys for deleted templates are
a declared growth bound rather than unbounded drift.

**`web/index.ts`**:

- `recordUsage(namespace, key)` — fire-and-forget POST; copy the call shape in
  `playback-history/web/components/record-play-observer.tsx`.
- `useUsageOrder(namespace, keys, resnapshotKey)` → `readonly string[]`:
  1. `usePointResources(usageStatsResource, keys.map(k => usageKey(namespace, k)))`
     — one coalesced subscription for the visible set
     (`primitives/live-state/web/window-hooks.ts:51`), not one sub per chip.
  2. Sort via `sortByUsage`.
  3. Hold the result in a ref; replace it only when `resnapshotKey` changes or the
     key set itself changes. **This is where the freeze lives** — so every future
     consumer gets stable ordering by default rather than re-deriving it.
  4. **Seed the first paint from a `persistent-draft` cache** keyed by `namespace`
     (`readDraft`/`writeDraft`, `@plugins/primitives/plugins/persistent-draft/web`),
     rewritten whenever a fresh order is snapshotted. Point resources are not
     boot-critical and hydrate post-mount, so without this the strip visibly
     re-sorts one round-trip after *every* conversation open. With it, first paint
     shows the last known good order and the settled data merely confirms it.

### Modified: `prompt-templates`

`web/components/prompt-template-chips.tsx` — the whole consumer change:

- `const order = useUsageOrder("prompt-templates", templates.map(t => t.id), convId)`,
  then reorder `templates` by it. Pinned becomes `ordered.slice(0, pinnedCount)`
  (line 89) and the panel maps `ordered` (line 144) — one derived array feeds both.
- Record on **both** use sites, not one: the ✎ insert-into-draft button (line 51,
  via `applyTemplate`) and the ➤ send-turn button (line 60, via `sendTemplate`).
  Put the `recordUsage` call inside those two handlers so the two surfaces that
  render `TemplateChip` (pinned strip and panel) can't drift.

`package.json` — add the `usage-rank` workspace dep. No config change:
`pinnedCount` and `templates` keep their current meaning, and the authored array
order remains the tie-break for never-used templates.

### Out of scope (worth a follow-up task)

The floating panel currently re-lists the pinned templates (visible in the picked
element: "Question only / Sonnet / Go" appearing twice). Pre-existing; ordering
does not change it either way.

## Verification

1. `./equin build`, then confirm the deploy receipt reads `status: ok` at
   `~/.singularity/worktrees/<wt>/build-status.json`.
2. `./equin check` — `migrations-in-sync` (the new table's migration must be
   generated by the build and committed), `plugin-boundaries`, `plugins-doc-in-sync`,
   `type-check`.
3. `bun test plugins/primitives/plugins/usage-rank/core/` — pure-logic tests for
   `decayedScore` (a 30-day-old score halves) and `sortByUsage` (stability: equal
   scores and never-used keys preserve incoming order).
4. Manual, at `http://<worktree>.localhost:9000`: open a conversation, click one
   template's ✎ and another's ➤ several times. Confirm via the `query_db` MCP tool
   that `usage_stats` holds the expected `use_count` / rising `score` for those two
   keys and nothing else.
5. Confirm the freeze: while staying in that conversation the chip order must
   **not** move after a click. Navigate to a different conversation — the new
   order applies there. Reload — no visible re-sort flash on first paint (the
   `persistent-draft` seed).
6. `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --url http://<worktree>.localhost:9000/agents/c/<id> --click "Go" --out /tmp/tmpl`
   for a before/after of the strip.
