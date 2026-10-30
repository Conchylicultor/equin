# worktree-cleanup

## Two universes, deliberately kept apart

The reaper answers two different questions with two different enumerations, and
mixing them is the mistake this plugin is shaped to prevent.

**Checkouts** are named by attempt ids — `isCanonicalWorktreeName`, i.e. `attemptIdKind.is` (`att-…` / `claude-…`). Every
branch of `collectReapable` that matches a name against it goes on to resolve a
git worktree path from that name, so **the regex must never be widened to admit
dotted names**. `sonata` and `sonata.att-X` are not checkouts; admitting them
there would hand a composition namespace — one of which is owned by main and
holds real user content — to checkout logic.

**Namespaces** are enumerated separately, from the provenance marker each one
carries (`listCompositionNamespaces`), and the question asked of them is not
"how old is it" but "is its OWNER still here". They come back in their own list
(`ReapScan.namespaceTargets`) so nothing can pass one to `reapAttempt`: a
namespace is reclaimed by `reclaimNamespace`, a checkout by `reapAttempt`.

`classifyOwnedNamespace` is the pure rule, unit-tested like `classifyAttempt`.
Only `checkout: "<name>"` can ever be a target — `null` means main owns it, and
an absent field means a marker older than the field, so the owner is unknown.
Unknown is not absent, and guessing drops a database.

## What `reapAttempt` reclaims, and what it delegates

1. the git worktree,
2. every namespace the checkout MINTED — asked for via
   `namespacesOwnedByCheckout`, never enumerated here, so a namespace kind
   invented later needs no edit — each reclaimed by `reclaimNamespace`,
3. the checkout's **own** namespace: fork DB → config dir → gateway registry.

Step 3 stays inline rather than calling `reclaimNamespace`, and that is the
split, not leftover duplication: a checkout's own namespace carries no
`composition.json`, and `reclaimNamespace`'s first guard refuses exactly that —
because a marker-less registry dir belongs to a checkout, which is this
function's job. Sharing the code would mean weakening the guard that tells the
two apart.

A namespace that fails to reclaim does not cost the checkout its own reclaim:
the failures are collected, the rest of the sequence runs, and `reapAttempt`
throws at the end naming each one. The hourly sweep contains that the same way
it contains any per-target failure (log + a deduped `worktree-reap-failed`
report) and the retry is structural — the checkout is gone, so its stranded
namespaces are precisely what the marker-owned branch enumerates next tick.

## The hourly sweep runs detached

`worktree-cleanup.reap-stale` is a `defineSupervisedJob` with a `run` body: the
sweep runs in its own `./equin supervised-exec` child, so a deploy or
restart of main no longer kills it mid-reap, and it holds no worker slot while it
runs. The built-in ledger (`supervised_job_runs`) locks it job-wide — an hourly
tick or the boot enqueue that lands during a sweep loses its claim and returns.
`runAttempts: 1`: the next tick is the retry, and a failed sweep dead-letters
(Debug → Queue) with the child's error. The child writes its lines to stdout /
stderr through `log`; the supervising backend tails them into the
`worktree-cleanup` channel (`logs/worktree-cleanup.jsonl`), so the child never
publishes to the sink itself. There is no time limit on a sweep; each git call
keeps its own timeout.

The manual delete endpoints still run `reapAttempt` inside the request.

## The panel reads one scan — `debug.worktree-cleanup.worktrees` (`shared/scan.ts`)

A key-range-PAGED value over the question `{ at }` (the instant the panel
asked: mount or Refresh, each a new question), newest first by `createdAt`:
the list grows with every attempt ever made, so the DataView reads it by
viewport (`useLivePagedValuePaging`) and only the pages on screen are live.
Its meta sibling is the scan's progress and safe count
(`{ planned, scanned, complete, safe }`).

Served external `"notified"` (`server/internal/scan-served.ts`): the
question's first subscriber starts ONE scan (`produceWorktreeEntries`,
`server/internal/entries.ts` — every attempt, then every dir orphan on main),
held in memory and pushed every 50 rows built and on completion, dropped at
the last unsubscribe. Nothing else watches the disk, so after completion only
deletes move it: `DELETE /:id` and `POST /bulk-delete` call
`refreshScannedRows(ids)` once their reaps end, which rebuilds those rows in
every held scan (one catalog query for all of them; an attempt's row survives
as "fully clean", a reaped dir orphan's leaves) and pushes them; the hourly
sweep, which reaps in its own child, calls `refreshSweptRows` from its
`onEnded` in this backend — it finds the held rows whose dir or fork DB moved
(`movedEntryIds`) and re-reads those. The completed scan's `scanned` is the
rows it holds, so a removed row leaves the count too. The list's fields sort,
filter, group and search by nothing — not even `createdAt`: the paged value
serves one order (newest first), and the DataView would do any sort or filter
over the loaded pages only. "Delete N safe" sends the scan's question,
not ids: the server deletes the safe rows of the scan the panel holds
(`safeIdsOf`, refused 409 while it is not held or not complete), so the panel
never has to hold the whole list. The scan's safe set can be hours old, so each
id is rebuilt (`rebuildEntries`) and judged again just before its reap; one no
longer safe is returned failed (`no longer safe`), never reaped.

## The step vocabulary is shared

`ReapStep` lives in `shared/endpoints.ts`, so the server's `onStep` and the
panel's label map read one list. A step added on the server is a `tsc` error in
the panel until it is given something to say.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Audit and remove stale git worktrees and their Postgres DB forks.
- Web:
  - Slots: `worktreeCleanupPane.Actions`
  - Slot contributors: `worktreeCleanupPane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "worktree-cleanup"
    - `DebugApp.Sidebar` "Worktree Cleanup"
  - Uses: 28 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×5
    - `primitives/css/ui-kit` ×3
    - `primitives/pane` ×3
    - `infra/endpoints` ×2
    - `apps/debug/shell.DebugApp`
    - `infra/ndjson-stream.readNdjson`
    - `network/live.useLive`
    - `primitives/css/fill.fillClasses`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/networking.useTransport`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (values): `worktreeCleanupPane`
- Server:
  - Contributes:
    - `report-kind` "worktree-reap-failed"
    - `resource.declare` "debug.worktree-cleanup.worktrees"
    - `resource.declare` "debug.worktree-cleanup.worktrees:meta"
  - Uses: 34 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/worktree` ×10
    - `infra/worktree/reclaim` ×4
    - `tasks/tasks-core` ×4
    - `database/admin` ×3
    - `infra/endpoints` ×3
    - `infra/host/host-read-pool` ×2
    - `infra/paths` ×2
    - `network/live` ×2
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `infra/ndjson-stream.ndjsonResponse`
    - `primitives/log-channels.defineLogSink`
    - `reports.ReportKind`
  - Register: `defineSupervisedJob('worktree-cleanup.reap-stale')`
  - Resources:
    - `debug.worktree-cleanup.worktrees` (keyed, window, notified)
    - `debug.worktree-cleanup.worktrees:meta` (push, notified)
  - Routes:
    - `POST /api/debug/worktrees/bulk-delete`
    - `DELETE /api/debug/worktrees/:id`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
- Exemptions:
  - Exempts itself from:
    - `no-db-backed-notify` — `server/internal/scan-served.ts` (sanctioned)
    - `endpoints:no-raw-json-handlers` — `server/internal/handle-delete.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/dirs.ts`, `server/internal/reap-policy.ts`, `server/internal/reap.ts` (debt)
- Shared:
  - Exports (types): `BulkDeleteWorktreesBody`
  - Exports (values):
    - `bulkDeleteWorktrees`
    - `BulkDeleteWorktreesBodySchema`
    - `deleteWorktree`

<!-- AUTOGENERATED:END -->
