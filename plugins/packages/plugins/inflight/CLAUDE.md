# inflight

In-flight request deduplicator: `createInflight(name)` returns
`{ run(key, fn, opts?), size }`. Concurrent callers sharing a `key` share one
execution of `fn` and one result; the key clears the instant the promise settles,
so it collapses *overlapping* work without caching a settled value. A
`Map<key, {promise, startedAt, token}>` and nothing more — releases the key in a
`finally` so a rejection is shared by the in-flight callers and then cleared (the
next call retries fresh).

This is a *concurrency* deduplicator, not a cache — pair it with a TTL cache if
you also want to reuse a settled result. Never use it where each caller needs a
distinct side effect (mutations): the shared body runs once.

## A join is a wait (`name`, `opts.onJoin`)

A joiner only waits on the starter's work, so its time there is never its own:
every join is shown on the joiner's open spans and charged when the flight
settles as a runtime-profiler `join` wait — `inflight:<name>` by default (the
name is required, so no deduplicator can leave its joiners' waits booked as
their own time). The default goes through an installed meter
(`installInflightJoinMeter`, installed by `runtime-profiler/server` beside
timed-fs's fs meter), not an import: the resource runtime builds on this
primitive and the profiler's server half on the runtime, so an import would
close a plugin cycle. With none installed (a browser, the CLI) a join is
metered nowhere. `opts.onJoin` names it under the caller's own layer instead
(`read-coalesce`, `endpoint-dedupe`, `git-coalesce:<name>`). The starter
waits for nothing: its time is `fn`'s.

## Detaching a flight (`fn`'s `flight.detach()`)

`fn` is handed its flight. `flight.detach()` takes the flight off its key
(token-checked, so a superseding flight is never evicted; sticky when called
before `fn`'s first await): every later arrival starts a fresh one, while
callers that already joined still share this flight's outcome. For a body that
gives up — the live read gate's abandoned read rejects, and a caller arriving
after that moment must not inherit the rejection.

## The freshness floor (`opts.notBefore`)

Overlapping in time is the right sharing rule for a caller that only wants the work
done once. It is the **wrong** rule for a caller that needs the read to reflect a
change that landed mid-flight: it would be served a body whose first read predates
the change it already knows about. Such a caller passes `notBefore` — an instant on
the `performance.now()` clock — and a flight that STARTED before it is **superseded**
rather than joined: `onSupersede` fires, a fresh flight starts and takes over the
key, every later arrival coalesces onto the fresh one. Omitting `notBefore` is
byte-identical to the plain deduplicator, which is what every read-only caller wants.

- **The old flight is not cancelled.** It keeps serving the joiners it already has,
  and settles normally. Nothing is thrown away.
- **Supersede, not chain.** Chaining behind the stale flight does not avoid the
  second body — both run either way — it only forces the fresh one to start after
  the stale one finishes, doubling the latency of the caller that asked for
  freshness. Admission control belongs to the gate the caller wraps around `fn`,
  not here.
- **The release is identity-checked** (`pending.get(key)?.token === token`): after a
  supersession two flights are live under one key, and the older one settling must
  not evict the newer entry — that would send the next arrival on a third redundant
  run and, worse, let it join a flight that had already been refused. The identity
  is a `token` minted before `fn` runs, not the promise, so a synchronously-throwing
  `fn` still releases correctly.
- **`startedAt` is stamped before `fn` is invoked**, not at its first real read, so
  a flight queued behind an admission gate looks older than it is. Deliberate: it
  yields false refusals (one extra run) and never a false join.
- **`size` counts keys, not flights.** A superseded flight is still running but no
  longer holds its key, so it is not counted.

Used to collapse identical concurrent reads that would otherwise each spawn
CPU-heavy work:
- the endpoints primitive's `dedupe` option (`plugins/infra/plugins/endpoints`)
  collapses concurrent identical GETs onto one handler invocation;
- `getEditedFiles(worktreePath)` so the edited-files loader and the
  plugin-changes endpoint share one git-status batch per worktree;
- the live-state resource runtime, whose read path coalesces freely while its push
  drains pass `notBefore` — the correctness-bearing consumer, since a drain mints a
  version and may not back it with a pre-commit read
  (`plugins/network/plugins/live/plugins/resource-runtime/CLAUDE.md`).

See `research/2026-06-15-global-live-state-cascade-contention.md` (Change 5) and
`research/2026-08-08-global-live-state-flight-freshness.md` (the freshness floor).

**A joiner holds no use-scoped gate slot while it waits** (`packages/semaphore`):
a use-scoped slot (the live read gate) is held only around a DB statement, file
call or child process, so waiting on the starter's work holds nothing — with
nothing to call here.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: In-flight request deduplicator: createInflight() collapses concurrent callers sharing a key onto one execution, plus a caller-supplied freshness floor (notBefore) that supersedes rather than joins a flight older than a change the caller already knows about.
- Cross-plugin:
  - Imported by:
    - `apps/chord/video-availability`
    - `apps/places/place-details`
    - `apps/sonata/covers`
    - `apps/sonata/sources/midi/folders`
    - `auth`
    - `conversations/conversation-view/commits-graph`
    - `conversations/runtime-sdk`
    - `infra/asset-mirror`
    - `infra/claude-cli/availability`
    - `infra/endpoints`
    - `infra/git/git-read-cache`
    - `infra/host-fs`
    - `infra/host-fs/image`
    - `infra/launcher/gateway-drift`
    - `infra/runtime-profiler`
    - `network/live/live-state`
    - `network/live/resource-runtime`
    - `packages/watched-memo`
    - `plugin-meta/plugin-tree`
    - `tasks/orchestration/mandate`
- Core:
  - Exports (types):
    - `Inflight`
    - `InflightJoinMeter`
  - Exports (values):
    - `createInflight`
    - `installInflightJoinMeter`

<!-- AUTOGENERATED:END -->
