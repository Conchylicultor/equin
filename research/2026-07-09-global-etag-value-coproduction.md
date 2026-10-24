# ETag/value co-production — kill the `edited-files` stale pin

Date: 2026-07-09
Category: global (framework/resource-runtime, infra/git-read-cache, conversations/conversation-view, review)

## Context

The conversation exit button intermittently settles on the destructive **Drop & Close**
while the worktree has real changed files, and the review pane shows *"No edited files."*
Only a page reload heals it. This has been reported and "fixed" three times:

| Commit | Date | What it actually fixed |
| --- | --- | --- |
| `3c0b91f9a` | Jun 12 | The button *flickered* `Drop & Exit` while resources were loading. Gated the mode on `useCombinedResources`. |
| `471b1eb70` | Jul 7 | The read path computed the ETag **after** the value, so a change landing between the two shipped a stale value stamped with a current ETag. Hoisted the signature above the loader. |
| `39d672a3b` | Jul 8 | `runGit` returned `null` on non-zero exit; `computeEditedFiles` absorbed it into a well-formed empty list. Made `runGit` throw. |

All three were real. None of them is this one. **A fourth, still-live cause remains**, and it is
the reason the symptom survives.

### Root cause: the ETag and the value are produced by different authorities

`edited-files` has two readers of "current state" that answer from different clocks.

- **`revalidate`** (`edited-files-resource.ts:58-74`) probes git *directly*: `rev-parse HEAD`,
  `merge-base main HEAD`, `git status --porcelain -z`, plus an `lstat` per dirty file. It is
  **instantaneously fresh**.
- **`loader`** (`edited-files-resource.ts:43-47`) calls `getEditedFiles` →
  `editedFilesMemo.get(wt, () => String(currentGeneration(wt)), compute)`
  (`get-edited-files.ts:77-83`). The memo signature is a **generation counter**
  (`edited-files-cache.ts:22-30`) bumped only when the @parcel watcher finishes a recompute —
  200 ms debounce, 2 s ceiling, and its compute sits behind `withHeavyReadSlot`. The value is
  only **eventually fresh**.

`createGitStateMemo`'s own contract, which `edited-files` is the sole violator of
(`git-state-memo.ts:11-13`):

> `signatureFn` … must fingerprint every input the result depends on, so a stale result is never served.

A generation counter fingerprints *how many times the watcher has run*, not git state.

**Skew 1 — divergent authorities.** In the window between a file write and the watcher's
recompute: `computeEtag` sees the new file → `E1`; the loader returns a memo hit at the old
generation → the pre-change list, often `[]`. The sub-ack ships `(V_stale, E1)`.

Because the resource is `mode: "invalidate"`, pushes carry no value and no ETag
(`runtime.ts:2181-2184`). The client's next refetch sends `If-None-Match: E1`; the server
recomputes the same `E1` from unchanged git state and answers `304` / `up-to-date`
(`runtime.ts:2431-2434`, `notifications-client.ts:649-655`). The client keeps `[]` **forever** —
nothing carries a value that could heal it, and the stored etag deliberately survives reconnect
(`notifications-client.ts:799-803`). Only another file edit moves the ETag, and by the time you
look at the exit button the agent has stopped writing.

**Skew 2 — coalescing.** Independent of Skew 1 and surviving any fix to it:
`getResourceValue` (`runtime.ts:1121-1132`) single-flights full loads on `${key} ${params}`.
Two concurrent `handleSub`s that computed *different* ETags (a change landed between their
probes) coalesce onto one loader run. The joiner receives the starter's older value and stamps
its **own newer ETag**. Same permanent pin, narrower window.

Why `471b1eb70` doesn't cover either: it enforces the invariant by *wall-clock read order*.
That is only sufficient if reading the value at time `T` yields the state at `T`. A memo returns
a value whose as-of time is the last generation bump; a coalesced flight returns a value whose
as-of time is the starter's. Reordering cannot fix a value that is stale on arrival.

### Why the neighbours don't show it

- **`commits-graph.delta`** gets it right: `deltaMemo`'s signature is `${headSha}|${mainSha}`
  (`compute-graph.ts:98-124`) and `revalidate` is `deltaEtag(headSha, mainSha)`
  (`resources.ts:87-92`) — same inputs, same authority. But they are written out in two files
  with nothing but a comment enforcing agreement.
- **`jsonl-events`** *does* have Skew 1 (etag = `lstat` of the transcript; loader returns a
  watcher-populated `cachedEvents` map) but is `mode: "push"`, so value-carrying `update` frames
  self-heal it. Latent, not live.

`edited-files` is the only resource that is both skewed **and** `invalidate`-mode. That
conjunction is what makes the pin permanent.

### The invariant to make structural

> A resource's ETag and its value must be produced by **the same flight over the same snapshot**.
> An ETag may describe a snapshot **older** than the value it accompanies (costing a needless
> recompute); it must **never** describe a newer one (which serves stale forever).

## Design

Five parts. Parts 1–2 are the structural home; 3–4 adopt it; 5 closes the absorbable-failure
hole the bug exploits at the UI end.

### 1. Runtime: value and ETag travel together

`plugins/framework/plugins/resource-runtime/core/runtime.ts`

- `getResourceValue(entry, params, ctx?, seedEtag?)` now resolves `{ value, etag }`.
  - Keep the scoped discriminator **exactly as is** (`if (ctx) return timedLoad(...)`, wrapped to
    `{ value, etag: undefined }`). Scoped loads never carry an ETag, so `ctx`'s type and every
    existing `ctx?.affectedIds` loader is untouched.
  - Full-load branch: the inflight body resolves `{ value: await timedLoad(...), etag: seedEtag }`.
    `createInflight` only runs the factory for the **starter**, so every joiner receives the
    starter's object and therefore **adopts the starter's seed, discarding its own**. That is the
    whole fix for Skew 2.
- `gatedRead(entry, params, seedEtag?)` threads the seed and returns `{ value, etag }`.
- `handleSub` (`:2430-2462`): keep `freshEtag = await computeEtag(...)` for the `up-to-date`
  short-circuit only — that comparison is against *this* subscriber's `clientEtag` and is correct.
  Pass `freshEtag` as the seed to `gatedRead`, then **stamp the returned `etag`, never `freshEtag`**.
  When the flight was started by a push-path caller (no seed) the returned etag is `undefined` →
  **omit the etag from the sub-ack**. The client then holds a value with no stored etag and its
  next revalidation does a full load. Do *not* fall back to the joiner's own `freshEtag`; that is
  precisely the skew.
- `handleResourceHttp` (`:2526-2568`): symmetric.
- Push-path and utility callers destructure `.value`: `drainEntry` (`:2134`, `:2195`),
  `drainMembershipFull` (`:1842`), `drainMembershipScoped` (`:1947`), `loadResourceByKey`
  (`:2682`), `measureSubscribeCycle` (`:2704`). `drainEntry` keeps computing `pushEtag` after the
  value (`:2180-2181`) — its "etag-after-value is safe here because the frame carries the value"
  argument (`:2171-2179`) still holds and is unchanged.

**Rejected: threading the ETag into the loader's `ctx` so a memo can key on it.**
`normalizeEtag` (`runtime.ts:916`) SHA1-hashes every signature before it leaves the runtime, so
the runtime never holds the raw string a memo would need as a cache key. Plumbing the raw
signature through would widen the loader `ctx` type and force the `if (ctx)` discriminator to
change, for the sole benefit of skipping one cheap signature re-probe. The seed stays a parameter
of `getResourceValue`; it never enters the loader.

Cost: on the read path a signed-memo resource probes its signature twice (once in `computeEtag`,
once inside `memo.get`). Both probes are cheap and ungated. This is exactly what
`commits-graph.delta` already does today.

### 2. New primitive: `createSignedMemo`

`plugins/infra/plugins/git-read-cache/server/internal/signed-memo.ts`, exported from that
plugin's `server/index.ts` alongside `createGitStateMemo`.

```ts
createSignedMemo<T>({ name, signature: (key) => Promise<string>, compute: (key) => Promise<T> })
  → {
      signature(key): Promise<string>;       // feeds `revalidate`
      get(key): Promise<T>;                  // feeds `loader`
      prime(key, signature, value): void;    // authoritative external writer
      evict(key): void;
    }
```

`signature` and `compute` are bound **at construction**, so `revalidate` and the loader come from
one object and cannot drift. That is the enforcement `createGitStateMemo` lacks: its per-call
`signatureFn`/`computeFn` let two call sites disagree, which is exactly how `edited-files` drifted
and the latent hazard `commits-graph.delta` avoids only by comment.

Implement over the same `Map<key, {signature, value}>` + `createInflight` internals as
`createGitStateMemo` (a thin wrapper binding the two functions is fine — keeps one cache/inflight
implementation). Preserve the `chargeWait` hit/miss markers.

`prime` contract, documented on the method: **the writer must capture `signature` BEFORE running
`compute`.** Then a change landing mid-compute leaves the stored signature older than the value; the
next `get` probes a newer signature, misses, and recomputes. Over-invalidates; never serves a torn
value under a matching signature.

`createGitStateMemo` stays — `plugin-tree`'s two memos and `commits-graph`'s bespoke split-signature
graph cache still use it.

### 3. `edited-files` adopts it; the generation counter dies

`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/`

The counter existed (per `edited-files-cache.ts:5-18`) because a *pure SHA* signature goes stale on
an uncommitted save. But `revalidate` already computes a **content signature** —
`editedFilesEtag(headSha, mergeBase, per-dirty-file lstat mtime+size)` — that does move on an
uncommitted save and is a faithful function of every input `computeEditedFiles` reads. That is the
correct single authority. It also keeps the wire ETag content-addressed, preserving the
cross-restart 304 herd-collapse `revalidate` was built for (a generation counter would reset on
restart and defeat it).

Module split (avoids the import cycle that would form if the memo declaration imported `compute`
from `get-edited-files.ts`, which imports the memo):

- **new `compute-edited-files.ts`** — `computeEditedFiles` moved verbatim from
  `get-edited-files.ts:87-164`. Leaf.
- **new `edited-files-signature.ts`** — `editedFilesSignature(worktreePath): Promise<string>`,
  extracted from `revalidate`'s body plus `statEntry` (`edited-files-resource.ts:19-30`). Leaf.
- **`edited-files-cache.ts`** — becomes the `createSignedMemo` declaration over those two, plus
  `primeEditedFiles(wt, sig, files)` and `evictEditedFiles(wt)`. **Delete** `currentGeneration`,
  `bumpGeneration`, the `generation` Map, and the generation doc block.
- **`get-edited-files.ts`** — `getEditedFiles(wt) = editedFilesMemo.get(wt)`.
- **`watch-edited-files.ts`** — capture the signature **before** computing, in both places:
  - `openRoom` (`:89-93`): switch the initial load from the read-through `getEditedFiles` to
    `sig = await editedFilesSignature(wt)` → `computeEditedFiles(wt)` → `primeEditedFiles(wt, sig, files)`.
    (Direct compute mirrors `recompute`'s existing discipline of never reading its own cache.)
  - `recompute` (`:155-157`): same ordering; keep the unchanged-JSON early return *after* the prime.
- **`edited-files-resource.ts`**:
  - `revalidate` → `editedFilesMemo.signature(wt)`. `!wt` **throws** (never `"none"`). A throw is
    caught by `computeEtag` (`runtime.ts:1163`) → `undefined` → no short-circuit → full load →
    the loader's throw → `sub-error`.
  - `loader` → `getEditedFiles(wt)`. `!wt` **throws**. Removing `return []` closes an
    absorbable failure (`no-absorbed-failure`): a conversation with no `worktreePath` currently
    renders as a legitimate "no changes" and arms the destructive default.

Post-fix, in the old bug window: `revalidate` → `memo.signature` → `S2`. The flight → `memo.get` →
probes `S2` → cache holds `S1` → **miss** → recompute → ships `(V2, S2)`. The loader is now exactly
as fresh as the ETag because they share one authority.

### 4. `commits-graph.delta` adopts it too

`plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/`

Today correct, but by convention. Replace `deltaMemo = createGitStateMemo(...)` with a
`createSignedMemo` over `signature: async (wt) => deltaEtag(...await probeHeadMain(wt))` and
`compute: (wt) => withHeavyReadSlot(() => computeDeltaCore(wt))`; point `revalidate`
(`resources.ts:87-92`) at `deltaMemo.signature(wt)`. Agreement becomes structural.

Leave the `!wt ⇒ revalidate "none"` / `loader EMPTY_DELTA` pair as-is: it is a *consistent*
signature/value pair for a real state (an attempt with no worktree), not an absorbed failure, and
`commits-graph.graph`'s bespoke split-signature cache is out of scope.

`jsonl-events` is left alone (push-mode self-heals). Note it in the plugin's CLAUDE.md as a
constraint: **it must not be changed to `invalidate` mode without first giving its loader and
`revalidate` a shared authority.**

### 5. The exit button stops treating "unknown" as "no changes"

`useResource` yields the descriptor's `[]` initial data alongside a non-null `error`, and
`combineResources` (`resource-utils.ts:51`) settles with `pending: false` while propagating the
first error. `push-and-exit-button.tsx:112-129` reads only `.pending` — so once the loader throws,
`files.length === 0` and the button arms **Drop & Close** on an *error*. Making the loader throw
without this change would move the bug rather than fix it.

- `push-and-exit-button.tsx`: add a `"exit-error"` mode (icon `MdErrorOutline`, label
  `"Close (state unknown)"`, non-destructive `PRIMARY` class, `run` = `exitConversation`) to the
  exhaustive `ICONS` / `BUTTON_CLASS` / `LABELS` records. In the `useMemo`, after the
  `exitDecision.pending` guard and **before** reading `exitDecision.data`:
  ```ts
  if (exitDecision.error) return { mode: "exit-error", provisional: false };
  ```
  Clickable (closing is always safe), visibly degraded, never destructive. Any of the three
  resources erroring makes the decision undecidable — hence the generic "state unknown".
- `drop-and-exit-button.tsx:54`: hide the destructive dropdown entry on `decision.error` as well as
  `decision.pending`.

### Blast radius: deleting `currentGeneration`

One cross-plugin consumer: `plugins/review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts:9,63`
uses `String(currentGeneration(wt))` as `worktreeTreeMemo`'s own `signatureFn`. Plus the barrel
export at `code/server/index.ts:7`.

That memo is **not** skewed — `pluginChangesResource` is `mode: "push"` with no `revalidate`, so
there is no ETag/value pair to skew; it only needs a faithful, fresh signature. (The whole
`plugin-changes` plugin is disabled, so this is a compile fix, not a live-path fix.)

Swap the barrel export `currentGeneration` → `editedFilesSignature` and repoint
`plugin-tree-cache.ts:63` to `() => editedFilesSignature(worktreePath)`. The content signature is a
strictly fresher and more faithful "worktree changed" signal than the debounced counter, and the
same safe over-approximation its comment (`:46-52`) already documents.

### `evict` + a signature-keyed memo: hazard *removed*, not introduced

The counter carried an unstated invariant: `evictEditedFiles` deleted both the cache entry and the
counter (`edited-files-cache.ts:43-46`), resetting the worktree to generation 0. A watcher
`recompute` that started before a `closeRoom` and landed after it would write `{generation: N, value}`
back into a freshly-reset namespace, where a new subscriber probing a low generation could **hit the
resurrected stale entry**. Correctness depended on nobody writing across an evict.

With a content signature there is nothing to reset: a late write-back stores `{contentSig, value}`,
and any reader probes the *current* content signature, so a surviving entry is served only if it
actually matches current git state. The hazard class disappears. `evict` stays as pure lifecycle
cleanup.

## Tests (`bun:test`)

**`plugins/framework/plugins/resource-runtime/core/runtime-revalidate.test.ts`** (extend; 7 existing
cases must stay green through the return-shape refactor)

- `memo skew: a fresh etag over a stale memoized value must not pin` — a resource whose
  `revalidate` returns `gitState` and whose loader returns a separately-controlled `memoValue`
  lagging behind it. Advance `gitState` 1→2 while the loader still yields `v1`; assert the sub-ack
  never ships `(v1, sig("2"))`. **Fails today.**
- `coalescing: a joiner adopts the starter's etag, never its own newer one` — two `handleSub`s
  coalesced onto one parked flight, `revalidate` advancing between their probes. Assert *both*
  sub-acks stamp the starter's seed, and a joiner resub with it mismatches → full reload.
  **Fails today.**
- `a push-started flight joined by a read sub omits the etag` — assert the sub-ack carries the
  value with no `etag`, never the joiner's own.

**`plugins/infra/plugins/git-read-cache/server/internal/signed-memo.test.ts`** (new)

- `revalidate and loader share one authority` — the signature under which `get` caches always
  equals `memo.signature(key)`; mismatched functions are unrepresentable.
- `prime with a pre-compute signature: a mid-compute change forces a re-probe, never a torn hit`.
- `hit acquires no compute; concurrent misses single-flight` — mirrors the `createGitStateMemo`
  expectations.

**`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-signature.test.ts`** (new)

- `signature moves on an uncommitted edit with no SHA change` — same `headSha`/`mergeBase`, a dirty
  file's `lstat` changes → different signature. This is the property that lets the counter die.
- `no worktree throws — never [] and never "none"` — both `loader` and `revalidate` reject.

**`plugins/primitives/plugins/live-state/web/resource-utils.test.ts`** — already covers
error-with-data settling; no change needed. Add a bun:test for the button's mode function only if
the mode derivation is extracted; otherwise cover via the two guards above.

## Verification

Drive the resource seam, not the browser — faster and deterministic.

**Reproduce first (must fail before the fix):**

1. `./equin build`.
2. `query_db`: pick a conversation with a worktree.
3. `curl -s -D- 'http://<wt>.localhost:9000/api/resources/edited-files?id=<convId>'` → record `ETag` + `value`.
4. In that worktree, `echo x >> some-file`, then **within the 200 ms–2 s watcher window** re-curl.
   Bug signature: the response carries a *new* `ETag` but the *old* `value` (no `some-file`), while
   `git -C <wt> status` shows it. A follow-up conditional GET with that ETag then returns `304`
   forever.

**Confirm cured:**

1. `bun test plugins/framework/plugins/resource-runtime/core/runtime-revalidate.test.ts plugins/infra/plugins/git-read-cache/server plugins/conversations/plugins/conversation-view/plugins/code/server`
2. Repeat the curl race: the response now always pairs the new `value` with the new `ETag`; a
   conditional GET returns `304` only once git state genuinely matches.
3. UI: with the conversation open, edit a file in the worktree → the exit button resolves to
   **Push & Close** without a reload. Use `e2e/screenshot.mjs` to capture before/after.
4. Kill the worktree's git dir (or point the conversation at a missing worktree) → the button shows
   **Close (state unknown)**, enabled, non-destructive — never Drop & Close.
5. `./equin build && ./equin check` (type-check, plugin-boundaries, `plugins-doc-in-sync`
   after the barrel export rename).

## Ordered implementation

1. `git-read-cache`: add `createSignedMemo` + `signed-memo.test.ts`. Isolated, no consumers.
2. `edited-files` leaf splits: `compute-edited-files.ts`, `edited-files-signature.ts` +
   `edited-files-signature.test.ts`.
3. `edited-files`: signed-memo declaration, delete the counter, update `get-edited-files.ts`,
   `watch-edited-files.ts`, `edited-files-resource.ts` (incl. the two `throw`s).
4. Barrel: `currentGeneration` → `editedFilesSignature`; repoint `plugin-tree-cache.ts:63`.
5. `commits-graph.delta`: adopt `createSignedMemo`; point `revalidate` at `deltaMemo.signature`.
6. Runtime: `{ value, etag }` + `seedEtag`; stamp the returned etag in `handleSub` /
   `handleResourceHttp`; destructure `.value` at the six other callers. Extend
   `runtime-revalidate.test.ts`.
7. UI: `exit-error` mode in `push-and-exit-button.tsx`; error-hide in `drop-and-exit-button.tsx`.
8. `./equin build` (regenerates registries + docs), `./equin check`, targeted `bun test`.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`
- `plugins/infra/plugins/git-read-cache/server/internal/signed-memo.ts` *(new)*, `server/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/{edited-files-cache,get-edited-files,watch-edited-files,edited-files-resource}.ts`
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/{compute-edited-files,edited-files-signature}.ts` *(new)*
- `plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/{compute-graph,resources}.ts`
- `plugins/review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx`

## Follow-ups (not in this change)

- `jsonl-events` shares Skew 1 but is masked by `mode: "push"`. Give it a shared authority, or at
  minimum pin the constraint in its CLAUDE.md.
- `edited-files` should distinguish "worktree clean" from "file set unknown" **on the wire**
  (a discriminated `EditedFilesPayload`) rather than relying on the resource error channel, so the
  destructive default is unreachable by construction rather than by a UI guard.
- `pushEtag` is computed unconditionally whenever `entry.revalidate` exists (`runtime.ts:2181`) and
  then discarded by the `invalidate` branch — for `edited-files` that is 3 git spawns + an `lstat`
  per dirty file thrown away on every watcher notify.
