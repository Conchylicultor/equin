# Cure the post-boot resubscribe herd: conditional revalidation (ETag/304) for live-state

**Date:** 2026-07-01
**Category:** global (live-state runtime + networking + conversation git/fs resources)
**Status:** design — not yet implemented.
**Companion docs:** [`research/perfs/issue-cold-boot-fanout.md`](./perfs/issue-cold-boot-fanout.md),
[`research/perfs/archive/2026-06-29-conversation-load-40s-fanout-herd.md`](./perfs/archive/2026-06-29-conversation-load-40s-fanout-herd.md).
Update both (and the perfs index) when this lands.

## Context

**The problem.** Every `./equin push` advances `refs/heads/main` → the git-watcher fires
`refAdvanced` → the `build.run` job → `./equin build` → the **main backend restarts**. Real
merges happen ~20×/day, so main reboots ~20×/day. Each restart kills every open WebSocket; on
reconnect the client's `replaySubs` ([`notifications-client.ts:494`](../plugins/primitives/plugins/live-state/web/notifications-client.ts))
re-subscribes **every** live-state resource for **every** open tab at once, with no jitter and no
admission control. On the server each fresh sub runs the resource's full loader
([`runtime.ts:1676`](../plugins/framework/plugins/resource-runtime/core/runtime.ts), `handleSub` →
`getResourceValue`). ~30 distinct route-parametrized loaders cold-fire simultaneously against the
**10-slot DB loader gate + one event loop**, producing the measured **40–75 s tails**
(`[acquire]` max 75.9 s). The conversation the user opened is a downstream **victim**.

This herd is the **amplifier**: it doesn't just slow conversation loads — it piles unbounded queued
work behind *any* post-boot event-loop block, inflating a warm ~10 s block into a cold ~46 s one.

**Why prior fixes never touched it.** The boot-snapshot + `live_state_snapshot` + xmin bounded
catch-up machinery (`ca4d2cd92`) persists and serve-from-snapshot **only `bootCritical`, param-less**
resources. The resources that dominate a *conversation* load are route-parametrized **and
git/filesystem-derived**, so they are structurally excluded from that machinery (verified):

- `editedFilesResource` / `jsonlEventsResource` are `defineExternalResource` (`externalSource`) — they
  issue **no DB query**, so they never appear in the read-set `tableToResources()` inversion the
  catch-up uses.
- `commitDeltaResource` / `commitsGraphResource` shell out to **git** (`merge-base`, `rev-list`,
  `log`), not SQL — also invisible to the table→resource map; they update only via `dependsOn`
  (`pushesResource`, `refHeadResource`) edges scoped to currently-subscribed attempts.

So extending the **xmin** catch-up to parametrized resources cannot work — xmin tracks Postgres
commits, and these resources' real inputs are git refs, working-tree files, and jsonl transcripts.
And the restart trigger is itself a push to `main`, which moves the merge-base for every worktree —
so the restart legitimately dirties a large fraction of these resources.

**The intended outcome.** Make a resubscribe (the herd) a **cheap "did anything change?" check**
instead of a full recompute, restart-safe, so an unchanged resource costs ~one `git rev-parse`
instead of a multi-call git diff — collapsing the herd in the common case and bounding it in the
worst case.

## The cure: conditional revalidation (ETag / 304) on the read path

**Key enabler.** A backend restart does **not** reload the page — the client's TanStack cache still
holds the last value for every `(key, params)`. So the server never needs to re-send an unchanged
value; it only needs to answer *"is what you already have still current?"*. This is exactly HTTP
conditional GET: the client carries the cursor (an ETag), the server validates cheaply and answers
`304 Not Modified` (here: an `up-to-date` frame) when nothing changed.

**Enabler #2.** These resources already compute a cheap git-state signature to decide whether to
recompute — `probeHeadMain()` → `headSha|mainSha|mergeBase`
([`compute-graph.ts:82`](../plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/compute-graph.ts)).
That signature *is* the ETag; computing it is one or two `git rev-parse`s (~ms) vs. the full
multi-call loader.

### Protocol (additive, opt-in, backward-compatible)

A resource may opt in by declaring a cheap signature function:

```ts
// new optional field on the SERVER resource definition (resource-runtime)
revalidate?: (params: ResourceParams) => Promise<string>;  // cheap content ETag; MUST be ≪ loader
```

Read-path behavior (both the WS sub-ack and the HTTP GET fallback wrap `getResourceValue`):

1. Client resubscribes, sending its last-known ETag for `(key, params)`.
2. If the resource declares `revalidate` **and** the client supplied an ETag:
   - compute `cur = await revalidate(params)` (cheap).
   - `cur === clientEtag` → reply **`up-to-date`** (no loader; client keeps its cached value).
   - else → run the loader (admission-capped, below), reply with `{ value, etag: cur }`.
3. No `revalidate` or no client ETag (first-ever subscribe) → today's full-loader path, unchanged.

**Soundness.** The ETag is recomputed from git/fs ground truth on every check, so it is
restart-independent by construction — no server-side durable cursor needed. The signature must be a
**conservative over-approximation**: when any input it can't cheaply hash might have changed, it
returns a fresh/unique value (forcing a recompute). Serving an occasional needless recompute is
acceptable; serving stale is not.

### Per-resource ETags (the four herd resources)

| Resource | mode | ETag (cheap signature) | vs. loader |
|---|---|---|---|
| `commits-graph.delta` / `.graph` | push | `headSha|mainSha|mergeBase` via existing `probeHeadMain()` + `pushedShas` hash | 1–2 `rev-parse` vs. `merge-base`+`rev-list`+`log` |
| `edited-files` | invalidate | `HEAD|mergeBase|hash(git status --porcelain=v1 -uall)` | 1 git call vs. 3 (`diff --name-status`+`status`+`diff --numstat`) |
| `jsonl-events` | push | transcript `path|mtime|size` (`fs.stat`) | `stat` vs. full file read+parse |

`jsonl-events` and `commits-graph` are **push**-mode → the ETag rides the **WS** sub-ack /
`up-to-date` frame. `edited-files` is **invalidate**-mode → its value already arrives via the **HTTP**
`GET /api/resources/edited-files` fallback, so it uses real **HTTP `If-None-Match` → 304** (the
cleanest fit — same `revalidate` function, standard transport).

### Files to change — the cure

**Server runtime — `plugins/framework/plugins/resource-runtime/core/runtime.ts`:**
- Add `revalidate?` to the resource definition type and carry it onto the registry `entry`.
- `handleSub` (~1640–1697): accept `m.etag`; before `getResourceValue` (~1676), if `entry.revalidate`
  and `m.etag`, compute `cur`; on match send a new `{ kind: "up-to-date", id, key, params }` frame and
  return; else run loader and include `etag: cur` on the `sub-ack`.
- `handleResourceHttp` (~1741): read `If-None-Match`; if `entry.revalidate` matches, return `304`;
  else return `{ value, version }` with an `ETag` header.
- Wire `revalidate` through `defineResource`/`defineExternalResource` (`server-core` +
  `central-core` facades) — additive optional field, central passes nothing.

**Client — `plugins/primitives/plugins/live-state/web/notifications-client.ts`:**
- Add `etag?: string` to `ActiveSub`; set it from `sub-ack`/`update` frames that carry one.
- `sendSub` (514): include the sub's `etag` when present.
- `handleServerMessage` (522): handle `kind: "up-to-date"` — a no-op confirm (do **not** reset the
  cached value; optionally stamp `lastAckVersion`/debug). Crucially `replaySubs` (494) must **keep**
  `sub.etag` across reconnect (it currently resets `version`/`lastAckVersion` to `-1`; the etag must
  survive so the resume can fire).
- HTTP path: `useResource`'s queryFn fallback
  ([`use-resource.ts`](../plugins/primitives/plugins/live-state/web/use-resource.ts)) sends
  `If-None-Match` and treats `304` as "keep cached value".

**The four resources** — add `revalidate` to each `defineResource`/`defineExternalResource`:
- `commits-graph/server/internal/resources.ts:61-105` (reuse `probeHeadMain` from `compute-graph.ts`).
- `code/server/internal/edited-files-resource.ts:16` (one `git status --porcelain` hash + `rev-parse`).
- `jsonl-viewer/server/internal/jsonl-events-resource.ts:16` (`fs.stat` of the resolved transcript).

## Surviving B′ pieces (answer to "is B still required?")

The cure removes the herd in the **common (no-change) case**. Two B′ pieces still matter because a
restart-causing push to `main` legitimately dirties many of these resources at once:

### Required — server read-admission cap (boundary invariant)

A `createSemaphore(N)` (reuse [`packages/semaphore`](../plugins/packages/plugins/semaphore/core/index.ts),
exactly as the DB loader gate does at [`client.ts:57`](../plugins/database/server/internal/client.ts))
inside `createResourceRuntime`, wrapping the **loader runs on the read path** (`handleSub` +
`handleResourceHttp`), **not** the push/flush cascade (that stays level-parallel, bounded by the DB
gate). This is the permanent invariant: no fan-out — boot, reconnect, or the dirty residual after the
cure — can ever run more than `N` cold read-loads at once. With the cure it rarely engages; it
guarantees the worst case can't stampede. Use `onWait` to record a profiler span (mirrors the DB
gate) so it's tunable from `get_runtime_profile`. Suggested `N` ≈ 6 (leaves DB-gate and interactive
headroom); validate empirically.

> Rationale split (rate × cost): the **cure** cuts the *rate* of cold loads (only genuinely-dirty
> keys recompute); the **cap** bounds the *concurrency* of whatever residual remains. Orthogonal
> axes — both wanted.

### Optional — reconnect jitter (cheap complement)

[`use-reconnecting-ws.ts:18`](../plugins/primitives/plugins/networking/web/use-reconnecting-ws.ts)
`BACKOFF_MS` is fixed, so a shared restart resyncs the whole fleet in the same ~500 ms tick. Add
equal jitter (`delay = base/2 + Math.random()*(base/2)`). Once a resubscribe is a cheap ETag check
this is no longer load-bearing — a one-line de-sync, nice-to-have. (`Math.random` is fine in app
code; the ban is Workflow-script-only.)

### Dropped — client resubscribe stagger

Subsumed by the server admission cap (one socket per browser; the server already bounds the
expensive half). Not worth the first-paint latency it would add.

### Not in scope — auto-build coalescing (lever C)

`buildRunJob` is already `dedup:"singleton"` + a durable in-flight lock
([`build-run-job.ts:18`](../plugins/build/server/internal/build-run-job.ts)), so near-simultaneous
pushes already collapse. The ~20/day restart rate is **legitimate merges** (legitimacy gate) — not
removable. No change; measure `build_runs` timestamps only if back-to-back restarts are ever observed.

## Implementation order

1. **Admission cap** (smallest, immediate containment; lands value even before the cure).
2. **Revalidation protocol** in the runtime + client (the cure scaffolding), behind the additive
   `revalidate?` field — no behavior change until a resource opts in.
3. **Opt the four resources in**, one at a time, each independently verifiable.
4. **Reconnect jitter** (one line).

## Execution (Opus subagents)

The revalidation protocol is a single server↔client **contract** — splitting server-ETag and
client-ETag across agents would risk drift — so it lands as one coherent unit, then the resource
opt-ins fan out. Sequenced (dependencies force order):

1. **Agent 1 (Opus) — protocol core + admission cap + jitter** (one coherent change):
   `revalidate?` field on the server resource def + facades; `handleSub` ETag branch → `up-to-date`
   frame; `handleResourceHttp` `If-None-Match`/`304` + `ETag` header; `createSemaphore` read-admission
   gate on the sub+HTTP loader runs (with `onWait` profiler span); client `ActiveSub.etag` +
   `sendSub` + `up-to-date` handling + `replaySubs` etag-preserve + `use-resource` `If-None-Match`/304;
   `BACKOFF_MS` jitter. Runs `./equin check type-check` to validate; no build/push.
2. **Agent 2 (Opus) — opt the four resources in + `bun:test` each** (after Agent 1's API exists):
   `commits-graph.delta/.graph` (reuse `probeHeadMain`), `edited-files` (git-status hash),
   `jsonl-events` (`fs.stat`). One agent, sequential resources (shared pattern).

Between agents I review the diff for contract consistency. After Agent 2 I run `./equin build`
once and verify. No `push` (user reviews first).

## Verification (end-to-end)

- **Reproduce the herd before:** `get_runtime_profile` on `singularity` right after a build/restart —
  confirm the simultaneous `sub` fan-out with `edited-files`/`commits-graph.delta` multi-second
  `sub` spans and `[acquire]` tail.
- **Cure:** with several conversation tabs open, trigger a main restart (`./equin build`).
  Tail `logs/live-state.jsonl` — resubscribes for unchanged conversations should show the new
  `up-to-date` path (no loader span), not a full `sub` load. `get_runtime_profile` `sub` count for
  `edited-files`/`commits-graph` should collapse to the genuinely-dirty set; event-loop max block in
  the post-restart window should drop sharply.
- **Cap:** `benchmark_boot` / `get_runtime_profile` — concurrent read-loads never exceed `N`; the new
  admission `onWait` span is visible and bounded under a synthetic herd
  (`debug/live-state-churn/emit`).
- **Correctness (no stale):** make a real change during downtime (edit a file / advance an attempt's
  branch / push), restart, confirm the affected resource recomputes (ETag miss) and the UI updates;
  confirm unchanged siblings do not. Add a `bun:test` for each `revalidate` (changed inputs ⇒
  different ETag; unchanged ⇒ identical).
- **Jitter:** confirm fleet reconnects spread across the backoff window in `logs/live-state.jsonl`
  timestamps rather than clustering.

## Risks / edge cases

- **ETag must cover every loader input.** A signature that misses an input serves stale. Mitigation:
  conservative over-approximation (unknown ⇒ fresh ETag ⇒ recompute) + a `bun:test` per resource.
- **`edited-files` working-tree state** is the hardest signature (untracked files don't touch
  `.git/index`); use `hash(git status --porcelain -uall)` — cheaper than the 3-call loader but not
  free; gate it behind the admission cap like any read-load.
- **Revalidate under a herd:** `revalidate` still spawns git/`stat`. It's cheap, but if measurement
  shows git-spawn pressure under a 30× herd, route `revalidate` through the same admission cap as the
  loader (it already protects the loader).
- **Full page reload** (not a backend restart) loses the client ETag → full loader, as today. That's
  correct: a cold page has no cache to validate against. The cure targets the dominant case (restart
  with the page still open).
