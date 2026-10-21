# git-read-cache

A small server-side infra library — `createGitStateMemo` — that memoizes an
expensive, gated recompute behind a **cheap, ungated signature probe**. It is
a pure library: a server barrel only (it uses the profiler and is never
browser-safe) with **no default `ServerPluginDefinition` contributions**, exactly
like `host-read-pool`. Three live-state levers collapse into this one
abstraction.

**The name is now a misnomer.** Nothing here is git-specific — the memo takes a
signature and a compute, and `jsonl-events` uses it over `lstat`s of a Claude
transcript chain, no git anywhere. The name records where the abstraction was
first extracted, not what it is. A rename (`infra/read-cache`?) touches four
importers plus the docs and has not been done.

## The git-state-keyed memo

> Read a **cheap, ungated signature** → on a signature match return the cached
> value **with no heavy slot acquired** → on a miss, single-flight the gated
> recompute and cache the result keyed by that signature.

`get(worktreePath, signatureFn, computeFn)`:

1. `signatureFn()` — the cheap, ungated probe. It runs on **every** call, so it
   must stay ~sub-millisecond (e.g. one ungated `rev-parse`, or a SHA git-watcher
   already holds in memory). It fingerprints **every input the result reads**.
2. signature unchanged ⇒ return the cached value immediately. **A hit acquires
   no heavy slot** — neither the per-worktree nor the host-wide
   `withHeavyReadSlot` is ever touched. This is the whole point: the storm path
   (a `main` advance fanning across ~16 worktrees and every open view) becomes
   mostly memo hits doing zero git work.
3. signature changed ⇒ run `computeFn()` under an embedded per-worktree
   single-flight and cache `{ signature, value }`. **`computeFn` owns its own
   `withHeavyReadSlot`** — the memo never touches the gate itself, so the gated
   recompute happens exactly where the compute body decides.

### Cheap-ungated-signature vs gated-compute split

The signature is deliberately the *thin ungated* read (`host-read-pool`
deliberately keeps cheap interactive git ungated), while the heavy `git log`/diff
body lives in `computeFn` behind the heavy-read gate. The split is what lets a hit
skip the gate entirely.

### Write-through prime — `set(worktreePath, signature, value)`

For an **authoritative external writer** that already holds both the value and the
signature it belongs to, `set` stores `{ signature, value }` directly — bypassing
`signatureFn`/`computeFn`. The next `get` whose `signatureFn` returns the same
signature is then a pure cache hit: no `computeFn`, no heavy slot.

The motivating consumer is **edited-files**, which reaches `set` through
`createSignedMemo`'s `prime` (below). The @parcel watcher is the authoritative
writer for working-tree state: it computes the file list directly (un-memoized, so
it never reads its own cache) and primes it under the **content signature** it
captured *before* that compute.

The signature must move on an uncommitted save, which changes the working-tree diff
**without moving any SHA** — so a bare git-SHA signature would serve stale data.
edited-files therefore folds each dirty file's `(porcelain code, lstat mtime+size)`
in alongside `(headSha, mergeBase)`. A **watcher generation counter** was used here
originally; it was not a fingerprint of git state at all, only of how many times the
watcher had run, and that divergence is what let a fresh ETag certify a stale value.
See `research/2026-07-09-global-etag-value-coproduction.md`.

`set` is the writer's responsibility for correctness: it must only store a value
it knows matches the signature it passes. The 3-arg `get` signature is unchanged.

**Same signature, same object.** A `set` under the signature already cached keeps
the held object, and a compute that finds its signature already cached when it
lands (a prime, or a fresher compute, landed meanwhile) hands its callers that
held object instead of its own. A reader comparing by identity
— the live runtime skips a recompute whose loader returns the object it last sent
(resource-runtime D8) — then sees an unchanged answer as unchanged.

### Embedded single-flight + worktree-keyed coalescing

An embedded `createInflight` (`@plugins/packages/plugins/inflight/core`), keyed by
`worktreePath`, folds stacked concurrent recomputes into one execution
(skip-in-flight). Because the key is the **worktree** (not conversationId /
attemptId), N conversations — and the delta+graph of one attempt — collapse onto
one compute + one cached value (coalesce fan-out).

## Staleness contract (non-negotiable: never serve stale)

- The signature **must be a faithful function of every input the result reads**.
  If the result depends on `HEAD`, `main`, the merge-base, and a pushed-shas set,
  all four belong in the signature — otherwise a change to an omitted input
  serves stale data.
- The signature is captured **before** the inflight body runs, so a second caller
  arriving with a *different* signature mid-flight shares the in-flight result.
  That shared result may be **≤1-event stale**; the next notify re-probes and
  recomputes if the signature has since moved. This mirrors the runtime
  single-flight's staleness-sharing contract on its READ path. It is sound here
  because nothing in this memo mints a version; where the runtime *does* (a push
  drain), it passes `inflight`'s `notBefore` floor instead of sharing
  (`research/2026-08-08-global-live-state-flight-freshness.md`).
- A caller that KNOWS an input moved at an instant passes that instant as
  `get(…, { notBefore })` (`SignedMemo.get(key, { notBefore })`): on a miss, a
  compute that started before it is superseded rather than joined, so the
  post-change read cannot inherit a pre-change value. The superseded compute
  still serves its own callers; settling late, it caches under its own older
  signature, so the next probe misses — over-invalidation, never a torn hit.
  (`release.candidate` uses it for a release close.)
- `evict(worktreePath)` drops a worktree's entry on the subscription lifecycle
  (e.g. a `whileSubscribed` stop); a later re-subscribe re-probes cheaply with one cold
  compute.

## Observability

A hit charges a 0ms `git-memo-hit:<name>` marker and a miss a 0ms
`git-memo-miss:<name>` marker via `chargeWait` (`runtime-profiler/core`). 0ms is
sound: with an active entry it adds 0 to the wait accumulator (no timing
pollution), and with no active entry it records a 0ms `db [git-memo-hit:<name>]`
span — a pure hit-rate signal. The 3-arg `get` signature is fixed; observability
never changes it.

## `createSignedMemo` — one authority for `revalidate` and `loader`

`createGitStateMemo.get(key, signatureFn, computeFn)` takes both functions **per
call**, so two call sites can pass functions that disagree about what "current"
means. A resource's `revalidate` and its `loader` are exactly two such call sites.
That is how `edited-files` drifted: `revalidate` probed git directly while the
loader's memo keyed on a watcher generation counter, so a fresh ETag certified a
stale value — and because the resource is `invalidate`-mode (pushes carry no
value), nothing could ever heal the client. A permanent stale pin.

`createSignedMemo({ name, signature, compute })` binds both **at construction**:

```ts
const memo = createSignedMemo<Files>({ name, signature, compute });
// resource: { revalidate: (p) => memo.signature(p.wt), loader: (p) => memo.get(p.wt) }
```

`memo.signature` feeds `revalidate`, `memo.get` feeds the `loader`. They cannot
diverge because there is nothing to pass — divergence becomes structurally
unrepresentable rather than a comment two files apart. Everything else (cache,
per-key single-flight, `chargeWait` markers, the ≤1-event staleness-sharing of a
mid-flight joiner) is `createGitStateMemo`'s: `createSignedMemo` is a thin binding
wrapper over exactly one cache implementation.

### `prime(key, signature, value)` — the ordering contract

The write-through prime for an authoritative external writer (the `set` of the
bound API). **The writer must capture `signature` BEFORE running its compute.**
A change landing mid-compute then leaves the stored signature *older* than the
value it labels: the next `get` probes a newer signature, misses, and recomputes.
That over-invalidates by one needless recompute; it can never serve a torn value
under a matching signature. Capturing the signature *after* the compute inverts
the skew — the entry would claim a snapshot newer than its value and every
subsequent `get` would hit it.

See `research/2026-07-09-global-etag-value-coproduction.md`.

## Consumers

**The rule: a resource that pairs a `revalidate` with a memoized `loader` uses
`createSignedMemo`.** That pairing is exactly the one that must not drift, and the
signed memo is the only thing that makes drift unrepresentable. Three do:

- **commits-graph** — its `delta` resource, signature `${headSha}|${mainSha}`. Its
  `graph` resource keeps a bespoke two-half cache for its genuinely-special
  split-signature incrementality, and is not a signed memo.
- **edited-files** — coalescing + skip-in-flight, with the @parcel watcher priming
  the cache under a pre-compute content signature.
- **jsonl-events** — signature over the `lstat`s of a conversation's Claude session
  chain, with the transcript watcher priming the cache under the signature it
  captured before reading. No git involved. Its ETag previously came from a direct
  `lstat` while its value came from a watcher-populated `Map`, and only
  `mode: "push"` (whose frames carry the value) kept that from becoming a permanent
  stale pin. See `research/2026-07-10-conversations-jsonl-events-shared-authority.md`.

**`review/plugin-changes`** and **`plugin-meta/plugin-tree`** use the plain
`createGitStateMemo`: no `revalidate` reads them (`review.plugin-changes` is a
pushed `serveValue` with none), so there is no ETag/value pair to keep in
agreement — they need only a faithful, fresh signature.

See `research/2026-06-19-global-incremental-git-loaders.md` (the unifying
primitive and Stage 2.1).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Git-state-keyed result memos: skip a gated git recompute when a cheap ungated signature is unchanged; single-flight + coalesce per worktree. createGitStateMemo takes signature/compute per call; createSignedMemo binds them at construction so a resource's revalidate and loader cannot drift.
- Cross-plugin:
  - Imported by:
    - `apps/file-explorer/git`
    - `build/deployment`
    - `conversations/conversation-view/code`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/subagents`
    - `plugin-meta/plugin-tree`
    - `release`
    - `review/plugin-changes`
    - `tasks/attempt-work`
- Server:
  - Exports (types):
    - `GitStateMemo`
    - `SignedMemo`
  - Exports (values):
    - `createGitStateMemo`
    - `createSignedMemo`

<!-- AUTOGENERATED:END -->
