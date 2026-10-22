# A declared `throttleMs` holds on a busy server

## Context

`liveValue`/`serveValue` (and `serveCollection`) `throttleMs` compiles to the
resource runtime's `debounceMs`: a fixed trailing window armed by the first
change. But `drainEntry` drains *every* entry with pending work in whatever
flush is running, and cancels the armed timer ("piggyback"). On a busy server
some non-throttled entry flushes every few ms, so a throttled entry recomputes
on nearly every change — `stats.cost.daily` measured ~18 rebuilds/min behind a
declared 30 s throttle (`research/2026-10-11-global-endpoint-reads-onto-live.md`,
Result (B9)). `stats.pushes.*` (5 s), `stats.tasks.history` (1 s),
`stats.commits.counts-by-category` (2 s) and every future heavy source declare
a bound the runtime does not keep.

Second hole, same class: a cascade (`cascadeDownstream` → `mergePending`) into a
throttled *downstream* never arms its window at all — it drains in the same
flush, so a throttle on a `recomputeOn`/`dependsOn` target bounds nothing even
on an idle server.

## Fix (rung 1: the wrong behaviour has no spelling)

Make the window the *only* thing that releases a throttled entry's pending:

- `RegistryEntry` gains `debounceDue: boolean` — the window elapsed and a flush
  is scheduled for it.
- `drainEntry`: a debounced entry drains only when `debounceDue`; otherwise it
  returns untouched (pending and owed acks stay, timer stays armed). Draining
  clears `debounceDue`. No more piggyback / timer cancel.
- `armFlush`: debounced → if neither a timer is armed nor the entry is due, arm
  the timer; the timer sets `debounceDue = true` then `scheduleFlush()`. A change
  landing while due rides the due drain (no second window).
- `cascadeDownstream`: after merging into a downstream, `armFlush(down)` when
  `down.debounceMs` — a non-debounced downstream still drains in the same cycle
  (deeper level), unchanged.
- `withNotifyBatch` exit: `armFlush` each entry with pending work (so a
  debounced entry notified inside a batch arms its window instead of being
  stranded or drained early).

Result: at most one drain per window per entry, whatever else flushes. Latency
is the declared window — the meaning `throttleMs` already documents ("at most
one flush per window"). Acks owed on a throttled tuple ride the window too
(already the documented contract: don't throttle an optimistic-mutation target).

Router quiescence checks (`pendingNotifies.has(pk)`) only get more conservative
while a pending is held — never wrong.

## Files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — the above;
  rewrite the `debounceMs` / `debounceTimer` docs.
- `plugins/network/plugins/live/CLAUDE.md` — drop "A flush already happening
  drains it early"; state the hold.
- `research/2026-10-11-global-endpoint-reads-onto-live.md` — no edit (history).

## Verification

- New runtime test: a throttled entry notified repeatedly while a non-throttled
  entry flushes every tick recomputes once per window; a throttled downstream
  of a cascading upstream waits for its window.
- `./singularity test plugins/framework/plugins/resource-runtime plugins/network/plugins/live`
- `./singularity build` (checks + deploy).
