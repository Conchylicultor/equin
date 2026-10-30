# Boot hooks over budget on every main boot

Boot-budget reports fire on every main boot (2026-10-30). The `onReady` hooks
run concurrently on one event loop, so a hook's wall time includes the others'
work. Each hook was judged by its own work, not its wall.

## Measured / read

| Hook | Wall | Own work | Verdict |
| --- | --- | --- | --- |
| `onReady:apps.prototypes.files` | 2044 ms | the boot signature read: 130 folders, one listing each, **~20 ms serial / 3 ms parallel** standalone; a warm `prototypes:refresh` (same read) averages 26 ms on main | contention: 130 sequential awaits, each queued behind the other hooks |
| `prototype-thumbnails:sync` (fire-and-forget in `onReady`) | 4478 ms | reads and sha256-hashes every prototype file: **~1.8 s** standalone (15 MB; ~0.9 s read, ~0.9 s pure-JS hash) | real, and run eagerly on every backend outside the warm-up executor |
| `onAllReady:debug.config-orphans#machine` | ~800 ms | a walk of the user-layer config dir + stats | report-only audit; whatever its cost, it holds the `onAllReady` barrier that gates the warm-up drain |
| `onReady:infra.events` | 903 ms | `syncTriggerContributions`: per declared trigger, one DELETE per trigger table (~23 tables) then one INSERT — ~750 serial statements, not atomic (a window with the triggers missing) | real |
| `onReady:conversations` | 770 ms | boot `reconcileAll` (per-active-row awaited plan/apply) | likely real — follow-up |
| `onReady:tasks.tasks-core` | 686 ms | push-ledger reconcile (git) + mandate CTE over every task + orphan sweep | likely real — follow-up |
| `onReady:infra.git.git-watcher` | 987 ms | ~3 serial `git rev-parse` spawns + a subscribe | mostly contention (spawn latency under load) — follow-up |
| `onReady:conversations.conversations-view.queue` | 552 ms | `repairBlockedOrder`: 1–2 queries per lead under the deck lock, ≥ 2 passes | likely real — follow-up |

The last four verdicts come from reading the code, not from timing it. Each is
filed as its own task.

## Changes

1. **prototypes/files watcher** — `onReady` subscribes and returns; the
   baseline signature is read as tracked work the refresh awaits before its
   first comparison, so it never compares against an empty map. A tree change
   delivered while the baseline is read names prototypes that the first refresh
   counts as changed, because the baseline may already hold that edit. This also
   closes the old window, where an edit between the baseline read and the
   subscribe was lost. A failed baseline read is reported, and the watcher
   continues from an empty baseline. `readPrototypesSignature`
   reads folders concurrently: one round of contention instead of 130.
2. **prototypes/thumbnails** — the boot reconcile becomes a `defineWarmup`
   (`worktree` scope: the thumbnail state is per-backend memory), drained
   after the host settles under the warm-up executor's gate and slot. It
   declares a 6 s budget: its hashing measured ~1.8 s standalone and 3.6 s of
   own time as a warm-up on a worktree boot. Re-hashing every unchanged
   prototype on every boot is filed separately.
3. **config-orphans** — the audit leaves `onAllReady` for a `worktree`-scoped
   `defineWarmup` (it still runs after every `onReady`, so it reads the full
   config registry).
4. **events** — `syncTriggerContributions` runs in one transaction: per trigger
   table, one DELETE of every declared job's rows and one multi-row INSERT of
   the declared triggers. That is ~46 statements instead of ~750, with no window
   where the triggers are missing.
