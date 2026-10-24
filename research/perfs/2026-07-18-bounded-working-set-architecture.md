# Bounded working sets — the structural rule that keeps the app usable under pressure

**Track:** [Host saturation — agent build/check fleets starve the main backend](./2026-07-08-host-saturation-agent-checks-starve-main.md) (Ongoing).
**Born from:** the 2026-07-17 compressor-thrash recurrence (see the addendum in
[`2026-07-11-compressor-thrash-subscription-replay-storm.md`](./2026-07-11-compressor-thrash-subscription-replay-storm.md))
and the question *"VS Code server on the same dying machine stays usable — why can't equin?"*.
This doc records the architectural answer as direction; it is philosophy + sequencing, not an episode log.

## The problem in one sentence

A single equin interaction (one pane navigation) triggers work whose memory working set is
**O(total application state)** — loaders re-aggregating whole collections, delivery materializing +
serializing full resource values, the GC marking the entire heap — so when the host squeezes the
backend's residency, that one interaction falls off the thrashing cliff and takes minutes; apps whose
interactions touch **O(one screen)** degrade to seconds on the same host.

## Evidence anchors (durable sources, independently re-verified 2026-07-17)

- **506 s page load** (`slow_ops`, `/agents/c/…/plugin/tasks.tasks-core`, completed 14:23:22 CEST)
  whose contention snapshot shows load 36 but **Postgres quiet** — the DB layer is exonerated.
- **393 s `deliver:conversation-categories` span** completing 14:23:11 CEST — 11 s before that page
  load resolved. Same family: `deliver:build.history` 344 s, `deliver:pushes` 185 s. These ops are
  normally sub-threshold (sub-second): a **~400× collapse factor**, which no additive slowdown produces.
- **Paging-victim signature** (`health.jsonl`): during each stall burst main's `residentMb` collapses
  to 66–150 MB of a ~700 MB `physFootprint` (~80–90 % of pages compressed out) with event-loop p50
  0.7–2.4 **s**; healthy stretches show 400–800 MB resident and p50 1–2 ms. ~10 bursts, clean
  dose–response. The pain is **episodic (cliff), not gradual** — the system crosses the knee when
  residency drops below the interaction path's working set.
- **Duress episodes** (`duress-episodes.jsonl`): repeated `decompressionsPerSec` trip/clear 12:40→14:28
  CEST; the longest episode (14:08–14:28) brackets the worst stall window (14:10–14:23).
- **Correction recorded:** the "main was down 11.5 min behind a never-ready socket" claim from the
  07-17 live session is **refuted** — the gateway's blue-green hot restart worked as designed
  (`gateway.log`: the 12:01 backend stayed active and serving through the 13:44 wedged spawn, drained
  only after the 13:56 successful swap). The user-visible minutes were the *live old backend* past the
  thrashing knee, not a dead socket. (A failed hot restart leaves no gateway log line — observability
  gap, owned by the debug-surface consolidation workstream.)

## Why minutes, mechanistically: the thrashing cliff

Slowdown under memory pressure is **super-linear past a knee**, not proportional. With free memory
pinned (~155 MB) the compressor churns both directions (~240 k compressions AND decompressions/s):
decompressing a page **evicts another** — including pages the same operation just faulted in. Any
sweep over a structure larger than the process's allowed residency evicts its own beginning before
reaching its end; every pass refaults everything (the process steals residency from itself). Below
the knee: normal speed. Above it: 100–500× collapse — a 1 s delivery becomes 393 s.

Three things put equin's paint path above the knee while VS Code's file-open stays below it:

1. **Wide sweeps per interaction** — loaders re-aggregate whole collections; delivery walks +
   serializes multi-MB object graphs; the GC mark phase walks the *entire* live heap (heap size is
   transitively part of every interaction's working set).
2. **Shared serial structures** — the 6-slot `read-admit` gate and the single `flushNotifies`/deliver
   pipeline convoy every request behind the collapsed one. Queue depth multiplies the collapse.
3. **Amplifiers firing at the worst moment** — sub replays and post-restart cold-boot fan-out raise
   the hop count exactly when the quantum is worst.

VS Code server on the same host: per-interaction working set of a few MB (file bytes + a hot,
constantly-touched protocol path), heavy work in separate processes, no shared gates. It degrades to
seconds. **Both apps degrade; the slope differs by the depth × width of their request pipelines.**

## The principle

> **An interaction's working set must be O(what's visible / what changed) — never O(total
> application state).**

Every standard architecture practice below is a way of enforcing that bound somewhere.

## The four structural rules modern stacks follow

### 1. The app-server process is stateless; state lives in a storage engine built for partial residency

Request path: query → stream rows → respond. The heap holds only in-flight request data. Bulk state
sits in Postgres/SQLite, whose B-trees make *fetching one record touch O(log n) pages* and whose
bounded, LRU-evicted buffer pools are precisely a data structure designed to run mostly-non-resident
without collapsing. **equin today:** live-state materializes every resource's full value as
object graphs in the backend heap — an unbounded, unevictable, GC-scanned in-process cache.

### 2. Derived data is maintained incrementally at write time, never recomputed at read time

CQRS / materialized-view discipline: reads fetch a precomputed row (working set = the row); writes pay
a small incremental delta. If reads never recompute, read cost cannot scale with collection size.
**equin today:** loaders like `conversation-categories` re-aggregate at read time — which is why
loaders are expensive, why the `read-admit` gate exists, and why there is a convoy to wedge. The
right primitive already exists in-tree: `database/derived-tables` (trigger-maintained rollups —
hand-rolled IVM). The structural move is making it the norm for resources, not the exception.

### 3. The managed heap stays small; bulk bytes live off-heap or out-of-process

GC mark walks the whole live heap, so heap size is transitively part of *every* interaction's working
set. Mature systems keep the GC'd heap at tens of MB and push bulk data to storage / byte buffers /
separate processes (GC sees one pointer, not a million objects). A backend whose heap is 80 MB has
nothing for the compressor to take hostage. **equin today:** heap churns 200–600 MB+ under
delivery backlog (the ±60–70 MB/10 s sawtooth), spreading live pages wide — the ideal paging victim.

### 4. Everything user-facing is windowed

Keyset pagination, virtual scrolling, bounded queries — O(one screen), never O(the collection).
**equin today:** the newest code already does this (mail inbox is a server-delegated keyset
DataView; `virtual-rows`), but the older resource model predates it: `config-v2.values` = 153 pks,
`page-block-doc` = per-block keys, full-collection task/conversation resources.

## The endgame: sync-engine architecture

For local-first live apps (Linear/Figma-class), the convergent 2024–26 shape is a **sync engine**
(Zero, ElectricSQL, PowerSync, Linear's syncer):

| Component | Working set | Why it survives pressure |
|---|---|---|
| Postgres | its own buffer pool | built for partial residency |
| Sync engine (separate process) | WAL tail + per-client cursors | ships *deltas*, O(what changed) |
| Client replica (SQLite) | pages the current query touches | B-tree + OS page cache, no GC |
| App-server heap | in-flight requests only | tens of MB — nothing to squeeze |

Reads never touch the app server; the client queries its replica, so paint is local and stale-first
**by construction** (no special "duress mode" — a rarely-exercised conditional path would rot; the
resilient path must be the only path). This is exactly what the `database/zero` pilot is
(zero-cache + SQLite replica + `zero-test` rendering the tasks slice). The 07-17 episode is the
strongest argument yet that the pilot is the strategic direction.

## Structural sequence for equin

1. **Stop warehousing materialized values in the backend heap.** Resource values belong in storage
   (they are already persisted to `live_state_snapshot`; the heap copy is the liability). The backend
   routes deltas; neither an interaction's data nor the GC's marking has hundreds of MB to sweep.
2. **Move read-time aggregation to write-time** via `derived-tables` / `query-resource` for the heavy
   resources (`conversation-categories` first — the recorded 393 s offender).
3. **Window the remaining unbounded resources** (`config-v2.values`, `page-block-doc`, full-collection
   lists) — the data-view keyset pattern is the precedent.
4. **Let Zero take over the read path** as the pilot matures.

**Co-design 1+2 as ONE contract, roll out per-resource.** They share the load-bearing decision
(*where does the materialized value live, and in what shape?*). Answering 2 with "derived rows in
Postgres" makes 1 fall out: the resource *is* a query over those rows, deltas = changed rows (the
change-feed already provides the signal). Designed separately, 1 would persist JS-computed blobs and
drag 2 back in anyway. The contract must be **row-shaped and delta-synced — i.e. Zero-compatible** —
so every migrated resource is also a step toward 4, nothing throwaway. Start with a measurement pass
ranking resources by value size × churn; the offender list is short and Zipf-distributed.

**Hard invariant for any "fast path":** it must keep a tiny working set (keyed row read, shallow code
path). If it ever grows to sweep wide state it falls off the same cliff.
**Acceptance test:** with the backend artificially squeezed (paging-probe-style pressure), any pane
paints in < 2 s from last-known state.

## What this does NOT fix (kept explicitly out of scope)

- **The host still thrashes** — self-inflicted fleet pressure (concurrent builds + agent sessions +
  Chrome filling 64 GB) needs **fleet memory admission + duress-gating deploys** (fix 3 of the 07-11
  doc, still unbuilt). Bounded working sets move equin to the shallow side of the cliff
  (minutes → seconds); admission stops the episodes from forming.
- **Observability gaps** (silent failed hot restart, never-ready-boot report kind, surface
  consolidation) — owned by the debug-surface consolidation workstream (2026-07-17 session).
