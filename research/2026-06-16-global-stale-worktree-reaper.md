# Automatic stale-worktree + orphan-fork reaper

## Context

The embedded Postgres cluster holds ~1601 worktree DB forks, ~99% stale — they correspond to long-gone git worktrees and most pre-date current schema (no `slow_ops` table, missing recent columns). The new cross-worktree slow-ops cluster view fans out a short-lived connection to *every* fork on each manual Refresh; it degrades gracefully (per-row errors), but opening ~1600 connections per refresh is wasteful and grows unbounded.

Root cause: **reaping does not keep pace with creation.** Every new attempt forks a DB (`database.fork` job) and creates a git worktree, but the only reaper is the *manual* "Delete N safe" button in the `worktree-cleanup` debug panel. Nothing automatic deletes orphaned forks or abandoned worktrees.

Goal: a durable, automatic reaper that (a) continuously drops orphan fork DBs whose worktree directory is gone, and (b) fully deletes worktrees older than **30 days** regardless of dirty/unpushed state. This bounds fork count and keeps the cluster fan-out small.

## Policy

A new scheduled job classifies each attempt/fork and reaps autonomously. Git hygiene (dirty/unpushed) is **not** consulted — the 30-day cutoff deletes regardless of state, and orphans have nothing to lose — so the reaper spawns **no `git status` subprocesses** (cheap even over the 1600 backlog).

| Condition | Action |
|---|---|
| Worktree dir gone, fork DB present (**orphan**) | drop DB + remove `~/.singularity/config/<id>` |
| Worktree dir present, age ≥ 30d, attempt not `active` (**stale**) | remove git worktree + drop DB + remove config dir |
| `att-*` DB with no attempt row, no worktree dir (**DB-only orphan**) | drop DB + remove config dir |
| otherwise | skip |

Safety floors: the main DB is named `singularity` (excluded by the `att-*` filter); the currently-running agent's worktree is recent (<30d) so never reaped; `active` attempts are never reaped even past 30d; `*__forking` temps are left to the existing `database.fork-temp-sweep`.

The existing **manual** path (conservative: clean + task done/dropped + ≥72h) stays as-is for humans who want to reap early.

## Implementation

All changes are self-contained in `plugins/debug/plugins/worktree-cleanup/`. No load-bearing infra is modified; everything reuses existing barrels.

### 1. Extract the shared reap action — `server/internal/reap.ts` (new)

Today the reap sequence (removeWorktree → dropDatabase → rm config dir) is duplicated inline in `handle-delete.ts` and `handle-bulk-delete.ts`. Extract one helper and have both call sites + the new job use it:

```ts
// reuses: removeWorktree (@plugins/infra/plugins/worktree/server),
//         dropDatabase (@plugins/database/plugins/admin/server), SINGULARITY_DIR
export async function reapAttempt(id: string, opts: { worktreePath?: string }): Promise<void> {
  if (opts.worktreePath && (await dirExists(opts.worktreePath))) {
    await removeWorktree(opts.worktreePath);
  }
  await dropDatabase(id);
  await rm(join(SINGULARITY_DIR, "config", id), { recursive: true, force: true });
}
```

Refactor `handle-delete.ts` and `handle-bulk-delete.ts` to call `reapAttempt` (keeping their per-step NDJSON streaming — they can emit step markers around the same primitives, or wrap). Keep their streaming UX intact.

### 2. Reaper policy + collector — `server/internal/reap-policy.ts` (new)

```ts
export const AUTO_REAP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FORK_DB_RE = /^att-\d+-[a-z0-9]+$/; // attempt id == fork DB name

// returns { id, worktreePath } list to reap, driven by listAttempts() + listDatabases()
export async function collectReapable(now: number): Promise<ReapTarget[]>
```

- Load `listAttempts()` (has `id`, `worktreePath`, `createdAt`, `active`) and `listDatabases()` → `dbSet` filtered to `FORK_DB_RE` (excludes `singularity`, `*__forking`).
- For each attempt: `dirExists(worktreePath)`, `dbExists = dbSet.has(id)`, `age = now - createdAt`.
  - orphan (`!dir && db`) → reap.
  - stale (`dir && age ≥ AUTO_REAP_AGE_MS && !active`) → reap.
- For each `att-*` DB not matched to any attempt: if its worktree dir (`worktreePathFor(id)`) is absent → reap (DB-only orphan).

Reuses `listAttempts` (`@plugins/tasks/plugins/tasks-core/server`), `listDatabases` (`@plugins/database/plugins/admin/server`), `worktreePathFor` (`@plugins/infra/plugins/worktree/server`).

### 3. Scheduled job — `server/internal/reap-job.ts` (new)

Mirror `forkTempSweepJob` / `ttlCleanupJob`:

```ts
export const worktreeReapJob = defineJob({
  name: "worktree-cleanup.reap-stale",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 * * * *" }, // hourly, main runtime only (no perWorktree)
  async run() {
    const targets = await collectReapable(Date.now());
    let reaped = 0;
    // small bounded concurrency (e.g. 6) — drops + occasional worktree removals
    await pMap(targets, async (t) => {
      try { await reapAttempt(t.id, { worktreePath: t.worktreePath }); reaped++; }
      catch (err) { Log("worktree-cleanup", `reap ${t.id} failed: ${String(err)}`); }
    }, 6);
    Log("worktree-cleanup", `auto-reap: ${reaped}/${targets.length} reaped`);
  },
});
```

Per-target errors are logged and do not abort the sweep (one corrupt fork mustn't block the rest) — this is *contained* failure of an idempotent background op, not silent swallowing; the next hourly run retries. Register via `register: [worktreeReapJob]` in `server/index.ts`.

`Date.now()` is in-process server code (not a Workflow script) so it is fine here.

### 4. UI note — `web/components/worktree-cleanup-panel.tsx`

Add a concise informational line (muted `Text` / existing primitives) above the table explaining the automatic policy: *"Orphaned forks are dropped hourly; worktrees are deleted automatically after 30 days. Use the controls below to reap early."* Keeps the panel honest about why the list stays short. No new heavy UI.

### Files

- `plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts` (new — shared `reapAttempt`)
- `plugins/debug/plugins/worktree-cleanup/server/internal/reap-policy.ts` (new — `collectReapable`, `AUTO_REAP_AGE_MS`)
- `plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts` (new — `worktreeReapJob`)
- `plugins/debug/plugins/worktree-cleanup/server/index.ts` (add `register: [worktreeReapJob]`)
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts` (call `reapAttempt`)
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-bulk-delete.ts` (call `reapAttempt`)
- `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` (info note)

## Verification

1. `./equin build` — compiles, migrations no-op (no schema change), server restarts and installs the hourly cron item (main runtime).
2. Inspect current fork count: `query_db` against `singularity` → `SELECT count(*) FROM pg_database WHERE datname LIKE 'att-%'`.
3. Manually trigger one sweep without waiting an hour: enqueue `worktree-cleanup.reap-stale` (via the Debug → Queue surface, or a one-shot `.enqueue({})`), then re-count forks — backlog of orphaned `att-*` DBs (worktree dir gone) should collapse toward the count of live worktrees.
4. Confirm a *recent* worktree (this agent's own `att-*`) survives: its DB still present, dir intact.
5. Check the `worktree-cleanup` log channel (`~/.singularity/worktrees/<wt>/logs/worktree-cleanup.jsonl`) for the `auto-reap: N/M reaped` summary line.
6. Open the worktree-cleanup debug panel — list is short, info note visible, manual delete still works.

## Tradeoffs / decisions

- **Hourly cron, main-only.** DBs are a global cluster resource; one main-runtime sweep covers all worktrees (mirrors `database.fork-temp-sweep`). Hourly is prompt enough for the fan-out pain without churn; the first run clears the ~1600 backlog.
- **No git-hygiene check in the auto path.** The 30-day rule deletes regardless of state (per explicit instruction), and orphans have no dir — so the reaper needs no `git status` subprocess, making the backlog sweep cheap.
- **30-day cutoff deletes unpushed/dirty work.** Accepted by the user. The age floor is the safeguard; `active` attempts are additionally protected.
- **Hosted in `worktree-cleanup` (debug umbrella).** Co-locates the automatic reaper with the manual one — same policy primitives, same plugin. The job runs on main regardless of declaring plugin.
- **Threshold is a constant (`AUTO_REAP_AGE_MS`).** A `config_v2` descriptor for enable/disable + age would be a clean follow-up but is out of scope for v1.
