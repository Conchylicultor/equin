# Converge all HTTP resource-cache writes onto one version-guarded path

**Date:** 2026-07-02
**Status:** design → implementing
**Area:** load-bearing (`primitives/live-state` web only)
**Follows:** `research/2026-07-02-cold-deeplink-http-prime-first-value.md` (the "version-guard
the existing invalidate/refetch HTTP write too" follow-up it filed).

## Problem

After the cold-start HTTP-prime landed, there are **two** HTTP resource-cache write
paths in `primitives/live-state`, with **different** guarantees:

1. `use-resource.ts` `fetchResourceValue` — `useResource`'s `queryFn` (WS-down fallback +
   `invalidate`-mode post-invalidate refetch). Writes via React Query's `queryFn` return,
   **bypassing the version guard** — a late HTTP response can clobber a newer WS value.
2. `notifications-client.ts` `primeFromHttp` — cold-start prime. Version-guarded
   (`setQueryData` only if `version > entry.version`).

The raw resource GET (URL build + conditional `If-None-Match`/304 + `{value,version}` parse +
`noteHttpEtag`) is **duplicated** across both files.

Only the newly-added prime path is guarded, so the whole "late HTTP clobbers newer WS value"
class survives on the `queryFn` path.

## Server version semantics (confirmed against `resource-runtime/core/runtime.ts`)

- One monotonic `entry.versions: Map<pk, number>` per `(key, params)`, for **all** modes
  (`push`/`update`, `keyed`, `invalidate`).
- Incremented in exactly one place — `drainEntry` (a real notify) at `runtime.ts:1475-1476`.
- Every WS frame (`sub-ack`/`update`/`delta`/`invalidate`) is **write-then-broadcast**:
  it carries the just-bumped value, so a genuine new frame is **always strictly greater**
  than the client's prior version → the WS guard's `<=` is correct.
- The HTTP GET (`handleResourceHttp`, `runtime.ts:1974`) **reports** the counter without
  bumping it → it can legitimately **equal** the version the client already applied. In
  particular, the `invalidate` frame bumps the client to `N`, then the post-invalidate
  refetch GET returns `N`.

**Consequence:** a uniform HTTP write guard must use **strict `<`** (drop only strictly-older),
not `<=`. `<` still drops a genuinely-stale late read (older than a newer WS value already
applied) but **accepts** an equal-version response — which is exactly the normal invalidate
refetch, and a harmless no-op write (structural sharing keeps the reference) for push/keyed.

Using `<=` here would silently discard invalidate mode's normal refetch — a real bug.

## Design

### One version-guarded HTTP method on `NotificationsClient`

`fetchOverHttp<T>(key, params, origin, schema, source): Promise<T>` — the single raw-GET site:

1. Conditional GET (reuse the existing ETag/304 logic).
2. `304` → return the cached value (defensive unconditional re-fetch only if the cache is
   somehow empty, so a needless 304 never leaves it blank).
3. `!res.ok` → `throw new ResourceHttpError(key, status)` (a typed error callers can classify).
4. Parse `{value, version}`; `noteHttpEtag`.
5. **Version guard (strict `<`):** if a sub `entry` exists, a cached value is present, and
   `body.version < entry.version` → drop (trace `stale-version`), return the retained cached
   value. This is the same guard discipline as WS frames, adapted for HTTP's report-not-bump
   semantics.
6. Else `schema.parse` (only when actually writing), `setQueryData`, advance
   `entry.version` monotonically (`max`, never lower), `markApplied`. Return the parsed value.
7. Throws on network (`TypeError` from `fetch`) / HTTP-status / schema failure — callers pick
   how to surface it.

Returning the **effective** cached value keeps React Query's contract intact: `queryFn`
returns data, `dataUpdatedAt` bumps, `pending` flips — no new render path. On a stale drop RQ
re-writes the retained value (a structural-sharing no-op).

### Two thin callers, differing only in error policy

- **`queryFn`** (`useResource`): `() => notifications.fetchOverHttp(key, p, origin, schema, "fallback")`.
  Errors propagate → `q.error` (WS-down fallback should surface failure). The local
  `fetchResourceValue` is **deleted**.
- **`primeFromHttp`** (cold start): wraps `fetchOverHttp(..., "prime")` fire-and-forget. A
  transient `TypeError` (network) or `ResourceHttpError` (status) is **swallowed + traced** —
  the WS sub-ack is the source of truth and will deliver. Anything else (schema/parse) is a
  real bug → rethrow via `queueMicrotask` (same loud-surfacing discipline as the WS
  `onmessage` path). Never rejects (safe to `void`).

The version guard now lives in **exactly one place** (`fetchOverHttp`), and the raw GET in
**exactly one place**. `primeFromHttp`'s old `<=` guard is removed (it delegates now); the
change to `<` does not regress the prime, which fires only at `entry.version === -1`.

## Blast radius

- `primitives/live-state` web only. No server / wire / schema change.
- Warm path unchanged. The `queryFn` fallback and invalidate refetch now share the WS guard.
- Fixes: late HTTP can no longer clobber a newer WS value on **any** path; invalidate refetch
  still lands (accepted at equal version by the strict `<`).

## Verification

- `type-check` + `eslint` clean; `./equin build`.
- Reason through: cold prime (entry -1) still applies; invalidate refetch (equal version)
  applies; a stale late HTTP (older than an applied WS value) is dropped and the newer value
  retained.
- Trace: `http … source=prime|fallback` success + `http drop … reason=stale-version` lines
  in `logs/live-state.jsonl`.
</content>
</invoke>
