import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { TranscriptSource } from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

// ONE module-level memo, shared between the served value (jsonl-events-resource.ts —
// BOTH its `revalidate` and its `loader`) and the transcript source's watch (the
// authoritative READER of the transcript, which primes through `watch`).
//
// The signature is the host's `TranscriptSource.signature` — on the desktop the CHAIN
// signature (transcript-watcher's `transcriptChainSignature`): `chainLength` plus a
// per-file (path, lstat mtime+size) triple. It is a faithful function of every input
// the read parses — an append moves a file's (mtimeMs, size), a session switch grows
// `chainLength` and adds a triple, a vanishing file drops a triple while `chainLength`
// stands.
//
// Before this, `revalidate` `lstat`ed the chain itself (instantly fresh) while the
// loader returned a module-level `cachedEvents` map written by the watcher's callback
// (fresh only AFTER the watcher fired). A read landing between a transcript append and
// that callback shipped a stale value stamped with an already-current ETag — the exact
// edited-files defect. It was non-fatal ONLY because this value is pushed: its frames
// carry the value, so a skewed sub-ack is superseded by the next push. The value's
// soundness rested entirely on a delivery choice recorded nowhere near it, and
// switching to `load: "on-demand"` (a few bytes per frame instead of the whole event
// array) would have silently reintroduced a permanent stale pin.
//
// `createSignedMemo` binds signature and compute at construction: `memo.signature`
// feeds `revalidate`, `memo.get` feeds the `loader`, and they cannot drift because
// there is nothing to pass. Push vs on-demand is now a delivery choice, irrelevant to
// correctness.
//
// On the desktop both halves resolve the chain first. A session switch landing between
// the memo's own signature probe and its own compute leaves the stored signature
// describing the OLDER chain — the safe direction: the next `get` re-probes, misses, and recomputes,
// costing one needless read. The dangerous direction (a signature newer than the value
// it labels, which every subsequent `get` would hit and serve forever) is unreachable,
// because the probe always precedes the compute it labels.
//
// See research/2026-07-10-conversations-jsonl-events-shared-authority.md and
// research/2026-07-09-global-etag-value-coproduction.md.
const memo = createSignedMemo<JsonlEvent[]>({
  name: "jsonl-events",
  signature: (id) => TranscriptSource.get().signature(id),
  compute: (id) => TranscriptSource.get().events(id),
});

export const jsonlEventsMemo = memo;

/**
 * Write-through prime from the transcript watcher (the authoritative reader): store
 * the freshly merged event list under the signature the watcher captured BEFORE
 * reading the chain, so the `notify` that follows finds a pure cache hit rather than
 * re-reading and re-parsing the whole chain on the push path.
 *
 * The signature-before-read ordering is the memo's `prime` contract, and the watcher
 * upholds it by fanning out `{ events, signature }` as one inseparable pair: an append
 * landing mid-read leaves the stored signature older than the value, so the next `get`
 * re-probes, misses, and recomputes. Over-invalidates; never serves a torn value under
 * a matching signature.
 *
 * The prime only ever hits if the watcher's signature and the resource's probe produce
 * byte-identical strings — which is why both come from the one TranscriptSource (on the
 * desktop, `transcriptChainSignature`) rather than agreeing by coincidence of two stat
 * APIs' float precision.
 */
export function primeJsonlEvents(
  id: string,
  signature: string,
  events: JsonlEvent[],
): void {
  memo.prime(id, signature, events);
}

export function evictJsonlEvents(id: string): void {
  memo.evict(id);
}
