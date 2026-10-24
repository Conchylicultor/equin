# Reliable reclamation of stale worktree registrations + DB forks

## Context

The dev host accumulated **~2363 gateway worktree registrations** and **3684 runtime-dir
entries** under `~/.singularity/worktrees/` while only **132 git worktrees are actually
live** (and 174 DB forks). The gateway adds one fsnotify watch per registry subdir
unconditionally and silently drops `w.Add` errors, so at this volume new worktrees
intermittently fail to register (the gateway goes partially blind to new `spec.json`
files). This is the root cause behind the related gateway-registration flakiness.

The `debug/worktree-cleanup` plugin already runs an hourly reaper
(`worktree-cleanup.reap-stale`, cron `0 * * * *`, main runtime, `dedup: singleton`), but
it is **not keeping the registry small** for two structural reasons:

1. **Incomplete removal.** `reapAttempt` (`plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts`)
   removes the git worktree dir, the DB fork (+ Zero artifacts), and `~/.singularity/config/<id>`,
   but **never the gateway registry entry** (`~/.singularity/worktrees/<name>/spec.json`
   subdir, or legacy flat `~/.singularity/worktrees/<name>.json`). The gateway's *only*
   deregistration path is the fsnotify `Remove`/`Rename` event fired when that spec file is
   deleted on disk (`gateway/registry.go` `remove()`). Because the reaper never deletes it,
   reaped worktrees stay registered forever and keep holding their fsnotify watch.

2. **Enumeration keyed off attempt rows.** `collectReapable`
   (`.../reap-policy.ts`) iterates `listAttempts()` ∪ DB forks. The 2516 legacy flat
   `<name>.json` files and orphaned subdirs have **no attempt row** (they predate the
   attempt system, or their attempt rows were already deleted), so they are never
   enumerated and never swept.

Net: the registry only grows. **Outcome we want:** the registry steady-state tracks live
git worktrees (~the 132), and the backlog of ~2300 stale entries drains automatically.

## Approach

`reapAttempt` is the single canonical removal sequence and `collectReapable` is the single
enumeration. We complete both — no new job, no new abstraction layer.

### 1. Add a `removeWorktreeSpec(name)` helper (own the registry layout in one plugin)

The worktree-cleanup plugin must not hardcode the gateway registry layout. Add a mirror of
`writeWorktreeSpec` next to it in `plugins/infra/plugins/worktree/server/internal/spec.ts`
and export it from the barrel:

```ts
// spec.ts — mirrors writeWorktreeSpec; removing the spec file is how the gateway
// deregisters (its fsnotify Remove handler calls registry.remove()).
export async function removeWorktreeSpec(name: string): Promise<void> {
  const dir = worktreesDir();
  // New layout: <worktreesDir>/<name>/ (spec.json + logs/ + ops/ + zero/replica.db).
  await rm(join(dir, name), { recursive: true, force: true });
  // Legacy layout: flat <worktreesDir>/<name>.json written by old CLI versions.
  await rm(join(dir, `${name}.json`), { force: true });
}
```

(Use `node:fs/promises` `rm`; `worktreesDir()` already lives in `worktree-op.ts`.)
Export from `plugins/infra/plugins/worktree/server/index.ts`.

### 2. Complete the removal sequence in `reapAttempt`

Add a final step (after the `config` step) that deletes the registry entry, surfaced as a
new `onStep` phase `"registry"` for the streaming UI:

```ts
opts.onStep?.("registry");
await removeWorktreeSpec(id);
```

This deregisters the worktree from the gateway via the existing fsnotify path **and** frees
its watch (deleting the watched subdir releases the kqueue/inotify watch). Update the
`onStep` union type and the UI step labels accordingly.

### 3. Complete the enumeration in `collectReapable` — registry-file orphans

After the existing attempt + DB-only-orphan passes, enumerate the registry dir and add any
name that is a true orphan: matches the worktree-id shape, has no live git worktree dir, and
is not already covered / active.

```ts
// Registry-file orphans: a spec entry on disk whose git worktree dir is gone and
// which has no attempt row. These are the bulk of the stale backlog. Removing the
// spec file deregisters from the gateway and frees its fsnotify watch.
const WORKTREE_NAME_RE = /^(att|claude)-\d+-[a-z0-9]+$/;
let names: string[] = [];
try {
  const entries = await readdir(worktreesDir(), { withFileTypes: true });
  for (const e of entries) {
    const name = e.isDirectory() ? e.name : e.name.replace(/\.json$/, "");
    if (WORKTREE_NAME_RE.test(name)) names.push(name);
  }
} catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }

for (const name of new Set(names)) {
  if (seenAttemptIds.has(name) || targets.has(name)) continue; // covered/active already
  if (!(await dirExists(await worktreePathFor(name)))) {
    targets.set(name, { id: name }); // no worktreePath: dir is gone
  }
}
```

Safety: the `WORKTREE_NAME_RE` guard excludes reserved namespaces (`singularity`, central,
etc.) so they are never touched. The `dirExists === false` gate means we only ever remove
entries whose git worktree is already gone — there is nothing to lose, mirroring the existing
"orphan" semantics (no extra age grace needed). Active attempts remain skipped via
`seenAttemptIds` + the existing `attempt.active` guard. `reapAttempt(name, {})` is idempotent:
`DROP DATABASE IF EXISTS` and `rm(..., {force:true})` no-op when the DB/config are already
absent.

### 4. Generalize the fork-DB pattern to `claude-*`

`FORK_DB_RE` in `reap-policy.ts` is `/^att-\d+-[a-z0-9]+$/`, so `claude-*` artifacts are
skipped by the DB-only-orphan pass. Reuse the single `WORKTREE_NAME_RE` above for both the
DB-orphan filter and the registry-orphan filter (one source of truth). (Live forks observed
are all `att-*`, but the registry has `claude-*` entries — those are reclaimed by step 3
regardless of DB.)

### 5. Drain the backlog promptly (don't wait up to an hour)

Enqueue the reap job once on **main** server `onReady` so the ~2300-entry backlog drains
shortly after `./equin build` rather than on the next hourly tick. `dedup: "singleton"`
prevents pile-up; steady-state runs find nothing. Gate to the main runtime (the reap-job is
already main-only). Add an `onReady` in the worktree-cleanup server plugin that calls
`worktreeReapJob.enqueue({})` only when running as main.

## Files to modify

- `plugins/infra/plugins/worktree/server/internal/spec.ts` — add `removeWorktreeSpec(name)`.
- `plugins/infra/plugins/worktree/server/index.ts` — export it.
- `plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts` — add `"registry"` step +
  call `removeWorktreeSpec`; widen `onStep` union.
- `plugins/debug/plugins/worktree-cleanup/server/internal/reap-policy.ts` — registry-orphan
  enumeration + shared `WORKTREE_NAME_RE`.
- `plugins/debug/plugins/worktree-cleanup/server/index.ts` — `onReady` backlog-drain enqueue
  (main only).
- `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` — add the
  `"registry"` step label to the streaming progress UI; update the caption to mention registry
  reclamation.
- (no schema change; no migration)

## Out of scope — file as follow-up tasks

- **Gateway self-healing (Go).** The gateway should (a) log `w.Add` failures instead of
  silently going blind, and (b) at `LoadAll`/periodic sweep, skip/evict registrations whose
  `spec.Server` repo root no longer exists — defense-in-depth so a stale spec can never anchor
  a watch even if the TS reaper is down. Also consider replacing per-subdir watches with a
  single recursive/top-level watch to remove the per-worktree-watch scaling cliff. Requires
  recompiling + restarting the gateway (`./equin start`), a system-level op outside the
  normal agent workflow — must be done by the user.
- **Other per-worktree artifact stores.** `~/.singularity/logs/<name>.log` (gateway backend
  log, 910 files) and any sidecar pid files are not reclaimed here. Confirm whether they
  should be folded into `reapAttempt` too.

## Verification

1. `./equin build` (deploys; runs checks).
2. Confirm the backlog drains: `curl -s http://localhost:9000/gateway/worktrees | python3 -c "import sys,json;print(len(json.load(sys.stdin)))"`
   should fall from ~2363 toward ~132 within a minute or two of boot. Re-run to watch it shrink.
3. `ls -1 ~/.singularity/worktrees | wc -l` should drop correspondingly; legacy `*.json`
   count (`ls ~/.singularity/worktrees | grep -c '\.json$'`) should approach 0.
4. DB forks: via `query_db` against `singularity`,
   `SELECT count(*) FROM pg_database` — orphan `att-*` forks with no live worktree get dropped.
5. Confirm a *live* worktree (this one, dir present) is **not** reaped, and the main
   `singularity` namespace still serves at `http://singularity.localhost:9000`.
6. Debug → Worktree Cleanup pane still lists/deletes correctly and shows the new
   "Removing registry…" step during a manual delete.
7. (Optional) `bun test plugins/debug/plugins/worktree-cleanup` if any unit tests are added
   for the new enumeration/guard.
