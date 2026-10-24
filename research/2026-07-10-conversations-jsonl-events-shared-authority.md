# `jsonl-events`: one authority for `revalidate` and `loader`

Date: 2026-07-10
Category: conversations (transcript-watcher, conversation-view/jsonl-viewer)

## Context

`research/2026-07-09-global-etag-value-coproduction.md` established the invariant:

> A resource's ETag and its value must be produced by **the same flight over the same
> snapshot**. An ETag may describe a snapshot **older** than the value it accompanies
> (costing a needless recompute); it must **never** describe a newer one (which serves
> stale forever).

That change fixed `edited-files`, introduced `createSignedMemo` as the structural home
for the invariant, and landed the runtime's `{ value, etag }` / `seedEtag` co-production.
It explicitly left `jsonl-events` alone as a filed follow-up. This is that follow-up.

`jsonl-events`
(`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-resource.ts`)
still derives its ETag and its value from two different clocks:

- **`revalidate`** `lstat`s every file of the conversation's session chain — instantaneously fresh.
- **`loader`** returns `cachedEvents.get(id)`, a module-level `Map` written by the transcript
  watcher's callback — fresh only *after* the watcher has fired.

A read landing between a transcript append and the watcher callback therefore ships a stale
value stamped with an already-current ETag. That is precisely the `edited-files` defect.

It does not bite today only because the resource is `mode: "push"`: its `update` frames carry
the value, so a skewed sub-ack is superseded by the next push. **The resource's soundness
rests entirely on that mode choice, and the mode choice is recorded nowhere near the code
that depends on it.** Switching to `mode: "invalidate"` — which looks like a pure win, since
an `invalidate` frame is a few bytes where a `push` frame re-ships the entire event array —
would silently reintroduce a permanent stale pin.

The goal is not to forbid the mode switch. It is to make the mode switch *irrelevant to
correctness*, so nobody has to know.

### Why the skew exists at all

The watcher is the authoritative reader of the chain, and it already stats before it reads
(`processRoom`, `transcript-watcher/server/internal/watcher.ts:166-187`). It simply never
tells anyone what it stat'd. The signature and the value are produced microseconds apart, by
one function, over one snapshot — and then thrown into two different containers, from which
two different consumers reassemble a mismatched pair.

There is also a **third** authority hiding inside the watcher: `processRoom` decides "did the
chain change?" from `Bun.file(path).lastModified` (integer ms), while `revalidate` fingerprints
`lstat().mtimeMs` (sub-ms float). Two definitions of the chain's identity, in one feature.

## Design

Move the chain signature to the authority that owns the chain, and make the watcher fan out
the value **together with the signature it was read under**. Then bind both halves through
`createSignedMemo`.

### 1. `transcript-watcher` owns the chain signature

The watcher already owns `resolveConversationTranscriptPaths` and `readJsonlEventsFromChain`.
The signature over those same files belongs beside them, not in a consumer.

Move `jsonl-viewer/server/internal/jsonl-etag.ts` (+ its `jsonl-etag.test.ts`) into
`transcript-watcher/server/internal/chain-signature.ts` (+ `chain-signature.test.ts`), keeping
the pure helpers and adding the `lstat` pass:

```ts
export interface ChainStat { path: string; mtimeMs: number; size: number }

/** One file's contribution. (was `jsonlEtag`) */
export function chainFileEtag(path: string, mtimeMs: number, size: number): string;

/** Signature of a whole chain, pure + unit-tested. (was `jsonlChainEtag`) */
export function chainEtag(chainLength: number, files: readonly ChainStat[]): string;

/** `lstat` every path; omit ENOENT (a file that vanished under us), rethrow anything else. */
export async function statChain(paths: readonly string[]): Promise<ChainStat[]>;

/** The bound signature: `chainEtag(paths.length, await statChain(paths))`. */
export async function transcriptChainSignature(paths: readonly string[]): Promise<string>;
```

Export `transcriptChainSignature` from `transcript-watcher/server/index.ts`. The existing
faithfulness argument in `jsonl-etag.ts`'s header comment moves with the code and still holds
verbatim — an append moves `(mtimeMs, size)`, a new chain entry moves `chainLength` and adds a
triple, a vanishing file drops a triple while `chainLength` stands.

**Note the `lstat`, not `Bun.file`.** The watcher's prime and the resource's `revalidate` must
produce byte-identical strings or every prime silently misses and the memo degrades to a full
re-read on every push. Routing both through `statChain` makes that structural instead of a
coincidence of two stat APIs' float precision.

### 2. The watcher fans out `{ events, signature }` as one inseparable pair

`watcher.ts`:

- `type Listener = (snapshot: TranscriptSnapshot) => void`, where
  `TranscriptSnapshot = { events: JsonlEvent[]; signature: string }` (exported from the server
  barrel; `JsonlEvent` already lives in `core`).
- `Room.lastMtimeMs: Map<string, number>` → `Room.lastSignature: string` (init `""`, which
  never equals a real signature, so the first process always fans out — same as today's
  "a path with no entry always reads as changed").
- `processRoom` becomes:

```ts
async function processRoom(room: Room): Promise<void> {
  if (room.transcriptPaths.length === 0 || !rooms.has(room.conversationId)) return;
  try {
    // Captured BEFORE the read — the memo's `prime` ordering contract. A change
    // landing mid-read leaves the signature older than the value, so the next
    // `get` re-probes, misses, and recomputes. Over-invalidates; never serves a
    // torn value under a matching signature.
    const signature = await transcriptChainSignature(room.transcriptPaths);
    if (signature === room.lastSignature) return;
    const events = await readJsonlEventsFromChain(room.transcriptPaths);
    room.lastEvents = events;
    room.lastSignature = signature; // paired with lastEvents, after a successful read
    fanOut(room, { events, signature });
  } catch (err) { /* unchanged per-room boundary */ }
}
```

  The signature is now the watcher's **sole** change-detector, so the `Bun.file` mtime map and
  its `exists()` pre-check disappear. It is strictly more sensitive than the old check (it also
  moves on a size-only change and on chain growth), and over-firing is safe.

- The late-subscriber path (`watchTranscript`, `watcher.ts:82-88`) delivers
  `{ events: room.lastEvents, signature: room.lastSignature }` — assigned together, so they
  cannot be handed out as a mismatched pair.

**One behavioral improvement, called out deliberately:** today `lastMtimeMs` is written
*before* `readJsonlEventsFromChain`, so a transient read failure permanently drops those events
until the next mtime change. Assigning `lastSignature` after a successful read closes that. The
pre-existing race where two concurrent parcel events both read (harmless — the read is
idempotent and the fan-out is deduped by signature) is unchanged.

### 3. `jsonl-viewer` binds both halves through `createSignedMemo`

New `jsonl-viewer/server/internal/jsonl-events-cache.ts`, modelled byte-for-byte on
`conversation-view/plugins/code/server/internal/edited-files-cache.ts`:

```ts
const memo = createSignedMemo<JsonlEvent[]>({
  name: "jsonl-events",
  signature: async (id) => transcriptChainSignature(await resolveConversationTranscriptPaths(id)),
  compute:   async (id) => readJsonlEventsFromChain(await resolveConversationTranscriptPaths(id)),
});
export const jsonlEventsMemo = memo;
export function primeJsonlEvents(id: string, signature: string, events: JsonlEvent[]): void;
export function evictJsonlEvents(id: string): void;
```

`signature` resolves the chain, then stats it; `compute` resolves the chain, then reads it. A
session switch landing between the memo's own probe and its own compute leaves the stored
signature *older* than the value — the safe direction, healed by one needless recompute on the
next `get`. The dangerous direction is unreachable.

`jsonl-events-resource.ts` collapses to:

```ts
loader:     ({ id }: Params) => jsonlEventsMemo.get(id),
revalidate: ({ id }: Params) => jsonlEventsMemo.signature(id),
async onFirstSubscribe({ id }: Params) {
  if (unsubscribes.has(id)) return;
  unsubscribes.set(id, watchTranscript(id, ({ events, signature }) => {
    primeJsonlEvents(id, signature, events); // prime BEFORE notify, so drainEntry's loader hits
    jsonlEventsResource.notify({ id });
  }));
},
onLastUnsubscribe({ id }: Params) {
  unsubscribes.get(id)?.();
  unsubscribes.delete(id);
  evictJsonlEvents(id); // pure lifecycle cleanup, as in edited-files
},
```

`cachedEvents`, the inline `lstat` loop, and the local `jsonl-etag` import all go away. The
cold-start fallback (`if (cached) … else read`) is now `memo.get`'s miss path, and the
first-subscribe race against a concurrent resource read collapses into the memo's embedded
single-flight for free.

**`mode: "push"` stays**, but it is now a *delivery* choice (stream the value with each frame)
rather than a correctness crutch. Switching to `invalidate` becomes a legitimate, purely
size-driven decision — which is the whole point of this change.

### 4. `turn-emitter` adopts the new listener shape

`plugins/conversations/server/internal/turn-emitter.ts:106` — one line:
`watchTranscript(id, ({ events }) => { void handleEvents(events); })`.

Chosen over a second positional `(events, signature)` argument, which existing callers could
ignore silently: the object names the pair, and the pair is the thing this change is about.

## Cost

Measured against the baseline, not in the abstract:

| Path | Today | After |
| --- | --- | --- |
| Read (`handleSub` / HTTP) | 1 resolve + N `lstat` (`revalidate`) + `Map` hit | 2 × (1 resolve + N `lstat`), value from memo hit |
| Push (`drainEntry`, ≥1 sub) | full chain read/parse (watcher) + 1 resolve + N `lstat` (`pushEtag`) | + 1 resolve + N `lstat` (the memo's probe → hit) |

A "resolve" is one index-backed `SELECT` on `conversation_sessions_by_conv_idx` returning ~1
row; `findTranscriptPath` caches positive hits, so the glob does not re-run. The read path's
double probe is exactly the accepted trade in `edited-files` (which double-probes *three git
spawns*). The push path's added probe rides alongside a `readJsonlEventsFromChain` that already
`JSON.parse`s every line of the whole chain and walks the uuid forest — tens of milliseconds
against a sub-millisecond indexed lookup. **Below the noise floor; no follow-up filed.**

The prime keeps the expensive half — the full chain re-read — off the read path entirely, as
it is today.

## Files

- `plugins/conversations/plugins/transcript-watcher/server/internal/chain-signature.ts` *(new; absorbs `jsonl-etag.ts`)*
- `plugins/conversations/plugins/transcript-watcher/server/internal/chain-signature.test.ts` *(new; absorbs `jsonl-etag.test.ts`)*
- `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts`
- `plugins/conversations/plugins/transcript-watcher/server/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-cache.ts` *(new)*
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-resource.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-etag.ts` + `.test.ts` *(deleted; moved)*
- `plugins/conversations/server/internal/turn-emitter.ts`

Reused, not rebuilt: `createSignedMemo` (`plugins/infra/plugins/git-read-cache/server`),
`resolveConversationTranscriptPaths` + `readJsonlEventsFromChain` (transcript-watcher).

### Docs

- `plugins/conversations/plugins/transcript-watcher/CLAUDE.md` — document `TranscriptSnapshot`:
  the signature is captured **before** the read, so a listener may prime a signed memo with it
  directly. This is the co-production contract, stated where the producer lives.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/CLAUDE.md` — record that
  `revalidate` and `loader` are the two bound halves of one `createSignedMemo`, so the resource
  is sound under **either** mode; `push` is a frame-size choice.
- `plugins/infra/plugins/git-read-cache/CLAUDE.md` — add `jsonl-events` to the consumer list.
  Also note the plugin name is now a misnomer (`createSignedMemo` is git-agnostic) — flagged,
  not renamed here.
- `plugins/infra/plugins/git-read-cache/server/internal/git-state-memo.ts` — the `set` docstring
  still cites the "monotonic generation signature" that the 2026-07-09 change deleted. Fix.

## Tests (`bun:test`)

**`transcript-watcher/server/internal/chain-signature.test.ts`** — the moved `jsonl-etag.test.ts`
cases (renamed to `chainFileEtag` / `chainEtag`), plus:
- `statChain omits a vanished file and rethrows a non-ENOENT error` — a chain path removed
  between resolve and stat drops its triple; an `EACCES` propagates rather than producing a
  signature built on a silent read failure.
- `signature moves on an append` — same path, grown `(mtimeMs, size)` → different signature.
- `signature moves when the chain grows` — a second session file appended to the chain.

**`transcript-watcher/server/internal/watcher.test.ts`** *(new)* — the load-bearing one:
- `the fanned-out signature describes a snapshot no newer than the fanned-out events` — write a
  temp `.jsonl`, subscribe, and assert the delivered `signature` equals
  `transcriptChainSignature(paths)` evaluated over the file state that produced those events.
  Append mid-flight and assert the delivered signature is the *pre-append* one (older, never
  newer) — the `prime` ordering contract, pinned at the producer.
- `a re-fanned identical chain is deduped by signature` — no second `fanOut` when nothing moved.

**`jsonl-viewer/server/internal/jsonl-events-cache.test.ts`** *(new)*
- `a prime under a pre-append signature does not pin` — prime `(sigBefore, eventsBefore)`,
  append to the transcript, then `memo.get` must re-probe, miss, and return the appended events.
  This is the exact failure mode `mode: "push"` was masking; it fails against today's
  `cachedEvents` map.

`createSignedMemo`'s own invariants (one authority; hit acquires no compute; concurrent misses
single-flight) are already pinned by
`plugins/infra/plugins/git-read-cache/server/internal/signed-memo.test.ts`; not re-tested here.

## Verification

1. `bun test plugins/conversations/plugins/transcript-watcher/server plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server plugins/infra/plugins/git-read-cache/server`

2. **Prove the skew is gone at the seam, not just under `push`.** The defect is invisible in
   `push` mode by construction, so drive `revalidate` and `loader` directly instead of the wire:
   a script that (a) reads `revalidate`'s ETag, (b) appends a line to the live transcript, (c)
   immediately reads the `loader`'s value — before the watcher fires. The returned value must
   either contain the appended event, or be accompanied by the *pre-append* ETag. Never the
   pre-append value under the post-append ETag.

3. **Confirm the prime actually hits** (the `Bun.file`-vs-`lstat` trap): with a conversation
   open, watch `get_runtime_profile` for `git-memo-hit:jsonl-events` vs
   `git-memo-miss:jsonl-events`. Steady-state streaming should be dominated by hits. A miss on
   every append means the watcher's signature and the resource's probe are not producing the
   same string — the exact silent-degradation this design exists to prevent.

4. **The resource still streams.** `./equin build`, open a live conversation at
   `http://<worktree>.localhost:9000`, and confirm new events appear without a reload. Capture
   with `bun e2e/screenshot.mjs`.

5. **Restart recovery.** Restart the backend with a conversation open: the cold `memo.get` miss
   path must re-read the chain (no `cachedEvents` to fall back on), and the client must
   re-render the full transcript.

6. `./equin check` (`type-check`, `plugin-boundaries` for the new
   jsonl-viewer → `git-read-cache` edge, `plugins-doc-in-sync` after the barrel export changes).

## Ordered implementation

1. `chain-signature.ts` + its test in `transcript-watcher`; delete `jsonl-etag.ts` + test.
   Barrel-export `transcriptChainSignature` and `TranscriptSnapshot`. No consumers yet.
2. `watcher.ts`: `lastMtimeMs` → `lastSignature`, `processRoom` rewrite, `fanOut` payload,
   late-subscriber pair. Add `watcher.test.ts`.
3. `turn-emitter.ts`: destructure `{ events }`.
4. `jsonl-events-cache.ts` + `jsonl-events-resource.ts` rewrite. Add the cache test.
5. Docs (four files above), then `./equin build` (regenerates registries + docs) and
   `./equin check`.

## Follow-ups (not in this change)

- **`jsonl-events` can now become `mode: "invalidate"`** on frame-size grounds alone: a `push`
  frame today re-ships the conversation's *entire* event array on every appended line, which for
  a long transcript is megabytes per keystroke-scale write. That was never safe to consider
  before this change. It needs its own look at the client's refetch behavior during streaming.
- `plugins/infra/plugins/git-read-cache` is misnamed now that `createSignedMemo` is git-agnostic
  and has a non-git consumer. A rename (`infra/read-cache`?) touches four importers and the docs.
- `drainEntry` computes `pushEtag` unconditionally whenever `entry.revalidate` exists
  (`runtime.ts:2215-2216`) and discards it in the `invalidate` branch — still open from
  `2026-07-09`.
