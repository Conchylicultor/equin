# Live-state HTTP cache poisoning — class fix + adjacent absorbed-failure fixes

## Context

Conversations frequently show a degraded **"Close (state unknown)"** push-and-exit button even though their worktree exists and the server is healthy. Diagnosed end-to-end (verified against the live system, `logs/live-state.jsonl`, and `/api/resources/_debug`):

1. `GET /api/resources/:key` responses carry an `ETag` but **no `Cache-Control`** (`handleResourceHttp`, `plugins/framework/plugins/resource-runtime/core/runtime.ts:3019-3073`), and the client's `fetchOverHttp` (`plugins/primitives/plugins/live-state/web/notifications-client.ts:691-739`) calls plain `fetch()` with no cache option.
2. The **browser HTTP cache** stores an old-boot body `{value, version: 1}` and later transparently revalidates it with its stored ETag. `edited-files`' ETag is deliberately restart-stable (content-addressed, for 304 herd-collapse), so after a backend restart the server 304s and the browser hands JS the **old-boot body**.
3. Server versions are **per-boot in-memory counters** (incomparable across boots). The WS path is protected by `bootEpoch`; the HTTP body carries **no epoch**. The client's strict-`<` guard (`body.version < entry.version`, `notifications-client.ts:721`) compares cross-boot versions and drops the body as `stale-version`.
4. The drop path returns `getCachedResource(...)` — on a freshly mounted pane that is the descriptor's **`initialData`** (`unresolved("not loaded")`). React Query marks the queryFn a *success* → the query **settles holding a placeholder the server never vouched for** → `deriveExitMode` sees `files.resolved === false` → "Close (state unknown)". Every retry re-304s; it never heals.

Adjacent absorbed failures included in scope (same "failure absorbed on an error path" family):
- WS `sub-error` frames are `console.error`'d and dropped (`notifications-client.ts:946-949`) — the resource wedges `pending` forever with `error: null`. (Server-side reporting already exists: `loader-failed` files a deduped crash report; only the client absorbs.)
- Plain JSON API responses are uncacheable only *by accident* (no validator, no Cache-Control) — any future endpoint adding `Last-Modified`/`ETag` by hand reintroduces the trap.
- No observability: this bug's only artifact was a JSONL trace line; nothing ever reached Debug → Reports.

Other current `revalidate` adopters (`jsonl-events`, `commits-graph`) are exposed to the same chain today.

## Fix A — Kill the rogue browser cache

- **Client** (`notifications-client.ts`): add `cache: "no-store"` to BOTH fetch calls in `fetchOverHttp` (the conditional GET at :703 and the defensive refetch at :712). This alone kills the bug.
- **Server** (`runtime.ts` `handleResourceHttp`): add `"cache-control": "no-store"` to the 200 headers AND the 304 branch. The handler that emits the `ETag` (the header that invites caching) owns forbidding cache storage; also covers non-`fetchOverHttp` consumers.
- Layer 3 is Fix E (dispatch-layer default). Keep all three — a regression removing any one leaves two.

## Fix B — Epoch-aware HTTP version guard

- **Server**: HTTP body becomes `{ value, version, epoch: bootEpoch, watermark? }` (unconditional; `bootEpoch` minted at `runtime.ts:973`).
- **Client**: add `epoch?: string` to `ActiveSub` (labels which boot `entry.version` belongs to):
  - Stamp in `handleServerMessage` where a version is adopted from an epoch-carrying frame (`sub-ack`/`up-to-date`; `up-to-date-batch` recurses through `up-to-date`, so one stamp site at ~:1001).
  - `update`/`delta`/`invalidate` frames leave `entry.epoch` unchanged (they only pass the `<=` guard relative to the same boot's stream; cross-boot WS is already handled by the replay baseline reset to -1).
  - Stamp in `fetchOverHttp` when a body is applied; on a **cross-epoch adopt**, set `entry.version = body.version` unconditionally (not monotonic — the old-boot number is meaningless).
- **Guard matrix** (replaces bare strict-`<` at :721; only when `entry` exists and `body.epoch` defined — epoch-less body from a pre-upgrade server keeps today's behavior):

| Case | Condition | Action |
|---|---|---|
| 1 Same boot | `body.epoch === entry.epoch` (or `entry.epoch` undefined) | keep strict-`<` (preserves the load-bearing equal-version accept for invalidate refetches) |
| 2 Entry is stale-boot | epochs differ, `body.epoch === channel.serverEpoch` | **ADOPT** (WS's current server identity vouches for the body's boot) |
| 3 Body is stale-boot | epochs differ, `entry.epoch === channel.serverEpoch` | **DROP** (`stale-epoch` trace), subject to Fix C's never-applied escape |
| 4 No arbiter | epochs differ, `serverEpoch` matches neither / undefined | **ADOPT** — this is the WS-down fallback window, the function's raison d'être; drop would starve the fallback for a whole outage |

- Poisoning safety: after a cross-epoch adopt, no live WS frame can mis-compare (a socket reopen resets the baseline to -1 before any frame applies). Do NOT extend the sub-batch echo to per-entry epochs (optional follow-up only).
- Keep `noteHttpEtag` + watermark adoption ordering exactly as today (watermark adopt only on the apply path, after the guard).

## Fix C — Never settle with a placeholder

- New predicate `NotificationsClient.hasAppliedValue(key, params)` = `(queryClient.getQueryState(queryKeyFor(key, params))?.dataUpdatedAt ?? 0) !== 0` (the exact signal `use-resource.ts:265` uses; `initialData` is seeded at `initialDataUpdatedAt: 0`).
- **304 path** (:704-713): keep-cached condition becomes `cached !== undefined && hasAppliedValue(...)`; when never-applied, fall through to the existing defensive unconditional refetch (with A, a genuine fresh 200). The old `!== undefined` check is structurally dead once a hook mounts — that is limb 4 of the bug.
- **Stale-drop paths** (same-epoch strict-`<` and case-3 stale-epoch):
  - `hasAppliedValue` → `return cached` (today's behavior — cache holds server-vouched newer truth).
  - never-applied → **throw new typed `ResourceStaleReadError`** (sibling of `ResourceHttpError`; carries `key`, `bodyVersion`, `haveVersion`, `reason: "stale-version" | "stale-epoch"`). Never return the placeholder (the bug); never apply the stale body (would render old-boot data under destructive buttons).
  - Convergence on the legitimate same-epoch race (invalidate bumped entry to N+1, GET raced the flush and returned N): throw → RQ `retry: 1` → flush landed → applies. If the retry also loses, `q.error` settles typed and visible (renders through `ResourceView`/`matchResource` error arm — no toast), and the next invalidate frame heals it.
- `primeFromHttp` (:752-765): add `ResourceStaleReadError` to the swallowed-transient set (prime is best-effort; WS sub-ack is truth), with its own trace line.

## Fix D — Surface `sub-error` on the client

- **Chosen mechanism**: on `sub-error`, call `applyInvalidate(msg.key, msg.params)` → the HTTP fallback refetch runs → its own outcome sets `q.error` naturally (500 loader-failed / 404 unknown-key → `ResourceHttpError`) or **heals if transient**. Reuses the single existing error channel; no queryClient internals; actually un-wedges the pane.
- **Frame change (server, all 4 sites)**: `{ kind: "sub-error", id?, key, params, reason }` — add `params` at `runtime.ts:2589`, `:2608`, `:2746`, `:2841` (in scope at each site).
- **Client** (:946-949): keep `console.error`, add a `trace(...)`, then gate on the local sub entry exactly like every other frame (shared socket broadcasts to every tab; a params-less legacy frame won't match → safe drop). When the entry exists → `applyInvalidate`. Update the `ServerMsg` union (:143).
- Retry bound: one frame → one invalidate → one queryFn (+retry 1); `sub-error` fires once per sub attempt; resubscribes only on socket reopen. `loader-failed` subs stay registered, so notify-heal also composes (version guard dedups).
- **Flagged pre-existing hole (out of scope, note in comment + file a follow-up task)**: `handleResourceHttp` runs no `authorize` check; moot today (zero `authorize` resources) but composes with this invalidate flow when the authorization seam ships.

## Fix E — Global `Cache-Control: no-store` default for API responses

- **server-core** (`bin/index.ts` `safeHandle` :256-280): after the handler returns, `if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store")`. Implement as a small helper `withDefaultCacheControl(res)`; the implementing agent must probe Bun header mutability on constructed Responses (`bun -e`) and use plain mutation if confirmed, else the `new Response(res.body, res)` clone fallback. The unmatched-404 at :318 stays as-is.
- **central-core** (`bin/index.ts`): add a `safeHandle` equivalent (try/catch → console.error with method/pathname → generic 500) — parity hygiene that central currently lacks — and apply the same cache-control default; route both dispatch call sites (:185, :192) through it.
- Media/raw handlers keep their explicit headers by construction (default only when absent): asset-mirror, attachments, screenshot, wallpaper, mail remote-images, code-explorer image, browser proxy — all verified to set their own. SPA bundle is served by the Go gateway (separate path) — untouched; the gateway is deliberately NOT the chokepoint (rebuild/restart is a system-level op).

## Fix F — Observability: deduped stale-drop wedge report

Mirror **optimistic-divergence** (sink in the primitive, collector + kind in `reports/*`) with **slow-resource-reporter**'s policy split (live-state counts, consumer thresholds):

- **Emitter** — new `plugins/primitives/plugins/live-state/web/stale-drop-reporter.ts`:
  ```ts
  export interface HttpStaleDropReport {
    key: string; params: Record<string, string>;
    reason: "stale-version" | "stale-epoch";
    consecutiveDrops: number;          // reset on any successful apply
    bodyVersion: number; haveVersion: number;
    bodyEpoch: string | null; entryEpoch: string | null; serverEpoch: string | null;
    source: "prime" | "fallback";
    neverApplied: boolean;             // wedge discriminator
  }
  export const httpStaleDropReportSink = defineReportSink<HttpStaleDropReport>();
  ```
  `NotificationsClient` keeps a `Map<string, number>` of consecutive drops keyed `${key}\0${pk}`, incremented in the drop branch (emit every drop with the running count), reset in `markApplied` (covers WS + HTTP applies). Import direction legal: live-state → report-sink (leaf).
- **Consumer** — new plugin `plugins/reports/plugins/live-state-stale-drop/` (copy optimistic-divergence structure file-for-file):
  - `core/live-state-stale-drop-kind.ts` — payload schema; `fingerprint = sha256("live-state-stale-drop|" + key + "|" + reason).slice(0,16)` (params/counts/versions excluded — one wedge = one bug).
  - `server/index.ts` — `ReportKind({...})`, `notifCooldownMs: 6h`; `renderTask` copy points an agent at `logs/live-state.jsonl` `drop reason=stale-*`, epoch comparison, endpoint Cache-Control.
  - `web/components/live-state-stale-drop-collector.tsx` — Core.Root sink registrant; **threshold here**: fire `report(...)` only when `consecutiveDrops === 3 && neverApplied` (exactly-equals → one report per episode; counter reset re-arms).
  - `web/components/live-state-stale-drop-kind-view.tsx` — one-line `Reports.KindView` summary.
  - barrels + `package.json` + `CLAUDE.md`.

## Fix G — Test coverage

- **Fetch seam**: extend the constructor hooks (`notifications-client.ts:322-327`) with `fetchImpl?: typeof fetch` (byte-for-byte mirror of `makeSocket`); `fetchOverHttp` uses it for both calls.
- **New** `plugins/primitives/plugins/live-state/web/__tests__/notifications-http-fetch.test.ts` (real client over `createTransportHub` + scripted `fetchImpl`), cases:
  1. URL + `cache: "no-store"` on both fetches; `If-None-Match` iff `entry.etag`.
  2. 304 with applied value → same reference, no write, no second fetch.
  3. 304 never-applied → second unconditional fetch, body applied (placeholder-guard pin).
  4. Same-epoch stale drop, applied → cached returned, sink emitted `consecutiveDrops: 1`.
  5. Same-epoch stale drop, never-applied → throws `ResourceStaleReadError`.
  6. Equal-version same-epoch → applies (strict-`<` regression pin).
  7. Cross-epoch adopt (case 2) → applies, version+epoch adopted.
  8. Cross-epoch drop (case 3) → cached / throw; trace `stale-epoch`.
  9. Case 4 (no arbiter) → adopts.
  10. Consecutive-drop counter resets on apply; sink payload correct.
  11. Epoch-less body → today's behavior byte-for-byte.
- **`notifications-subs.test.ts`**: sub-error with params for a held sub → invalidate spy called; not-held → no invalidate (broadcast-gate pin); legacy params-less frame → safe drop.
- **Server pins**: `runtime-version-shortcircuit.test.ts:236-259` (+`epoch` in body), `runtime-watermark.test.ts:174-191` (+`epoch` shape), `runtime.test.ts:769-802` (+`Cache-Control: no-store` on 200/304). NEW sub-error tests (`unknown-key` via handleSub + handleSubBatch, `loader-failed` via throwing loader, `unauthorized` params echo).
- `test-support.ts` `applyHttpRefetch` (:365-370) — extend to `{value, version, epoch?}` and mirror the matrix.
- Run the full H1–H7 fence: `bun run test:dom plugins/primitives/plugins/networking plugins/primitives/plugins/live-state`; server: `bun test plugins/framework/plugins/resource-runtime`.

## Files

Modify:
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` (A,B,C,D,F,G)
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (A,B,D)
- `plugins/framework/plugins/server-core/bin/index.ts` (E)
- `plugins/framework/plugins/central-core/bin/index.ts` (E)
- `plugins/framework/plugins/resource-runtime/core/test-support.ts` + `runtime.test.ts`, `runtime-version-shortcircuit.test.ts`, `runtime-watermark.test.ts` (G)
- `plugins/primitives/plugins/live-state/web/__tests__/notifications-subs.test.ts` (G)
- `plugins/primitives/plugins/live-state/web/index.ts` barrel (`ResourceStaleReadError`, `httpStaleDropReportSink`, `HttpStaleDropReport`)
- `plugins/primitives/plugins/live-state/CLAUDE.md`, `plugins/framework/plugins/resource-runtime/CLAUDE.md` (epoch-in-body rule, never-applied guard, no-store invariant)

Create:
- `plugins/primitives/plugins/live-state/web/stale-drop-reporter.ts`
- `plugins/primitives/plugins/live-state/web/__tests__/notifications-http-fetch.test.ts`
- `plugins/reports/plugins/live-state-stale-drop/{package.json, CLAUDE.md, core/index.ts, core/live-state-stale-drop-kind.ts, server/index.ts, web/index.ts, web/components/live-state-stale-drop-collector.tsx, web/components/live-state-stale-drop-kind-view.tsx}`

## Implementation split (Opus agents; streams 1–3 parallel, final pass sequential)

- **Agent 1 — server**: epoch in HTTP body + no-store (handleResourceHttp); params on 4 sub-error sends; Fix E in both bins (probe Bun header mutability first); server test updates + new sub-error tests + `test-support.ts` mirror. `bun test plugins/framework/plugins/resource-runtime`.
- **Agent 2 — client**: fetchImpl seam + no-store; ActiveSub.epoch + guard matrix + stamps; hasAppliedValue + 304 predicate + ResourceStaleReadError + prime swallow; sub-error handling + ServerMsg; stale-drop sink + counter + markApplied reset; new test file + subs-test additions + barrel exports. `bun run test:dom plugins/primitives/plugins/networking plugins/primitives/plugins/live-state`.
- **Agent 3 — reports consumer + docs**: `reports/plugins/live-state-stale-drop` (copy optimistic-divergence, adapt); CLAUDE.md updates. Depends only on the frozen sink interface above.
- **Final sequential pass**: `./equin build` (registry regen + boundary checks), both test suites, fix integration drift.

## Verification (end-to-end)

1. `curl -is 'http://<wt>.localhost:9000/api/resources/edited-files?id=<conv>'` → `Cache-Control: no-store`, `ETag`, body has `"epoch":"<uuid>"`. Repeat for a plain JSON endpoint (Fix E) and `/api/central-resources/*`.
2. Reproduce the original wedge: open a conversation pane (browser caches body), restart the backend, reload → button shows real state; DevTools Network shows no disk-cache/304 replay on the resource GET.
3. `tail -f ~/.singularity/worktrees/<wt>/logs/live-state.jsonl` through a restart: at most transient `stale-epoch` drops that heal; never a repeating same-key drop loop.
4. `GET /api/resources/_debug` — versions/short-circuit counters sane.
5. Sub-error: temporarily break a loader in a dev worktree → pane shows error arm (not infinite pending); after 3 consecutive never-applied drops a single deduped row appears in Debug → Reports.
6. Two-tab smoke through a backend restart (leader-broadcast gating).

## Decisions adopted (flagged during design, recommendation taken)

1. **B case 4 (no arbiter): ADOPT** — a live response beats a memory of unknown vintage; drop would starve the WS-down fallback.
2. **C never-applied stale-drop: throw typed error** — applying the stale body could render old-boot data under destructive buttons; throw + retry + invalidate-heal converges and fails loudly.
3. **D: invalidateQueries** — reuses the one error channel, heals transients; the `handleResourceHttp` no-authorize hole is pre-existing and moot (file a follow-up task when the authorize seam ships).
4. **F: dedicated report kind plugin** — byte-for-byte precedented (optimistic-divergence); own fingerprint/renderTask.

## Follow-up tasks to file (not in this change)

- ~~`handleResourceHttp` authorize parity when the `authorize` seam gains a real consumer.~~ Superseded: `createResource` now **throws at registration** if a resource declares `authorize` ("not enforced on the HTTP read path yet"), converting the future silent bypass into an impossible state. The eventual first consumer builds one shared admission check across handleSub / handleSubBatch / handleResourceHttp, deletes the guard, and restores the WS-enforcement tests from history.
- Optional: per-entry epoch echo in the sub-batch replay (micro-optimization of post-restart replays).
