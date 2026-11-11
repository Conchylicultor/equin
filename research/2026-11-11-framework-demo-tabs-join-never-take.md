# Demo tabs join the running host, never take it — and every end says why

## Context

User report (2026-11-11): the demo sometimes shows "This demo was opened in
another tab … Reload" instead of running. Several tabs must always share one
demo. That screen is `HostEndReason` `"superseded"`: another worker claimed the
host's storage (`host-storage/ownership.ts`) and the holder yielded. The one
message covers every cause, so it is often false.

## Every path to "superseded" today

The holder yields to ANY claimant whose migrations ⊇ its own and whose
snapshot is not older. Claimants:

1. **Same build, another generation's name.** `demo/prestart` names the
   SharedWorker `<scenario>@<generation>`; a page skips a name whose retire
   lock is unavailable (`connectSharedHost`). With `ifAvailable`, a retire
   request merely QUEUED (behind page A holding the lock shared while it
   connects) already reads as unavailable: page B moves to N+1 while A joins
   N; N+1's worker claims, N (serving A) yields → A superseded. (The known
   edge of the end-of-life change: two tabs within ms of the last one leaving
   — e.g. reload + new tab.) Any other divergence of generations between tabs
   (a lost localStorage write, a stale tab) ends the same way.
2. **A newer build** (deploy: new content-addressed worker URL = another
   SharedWorker) claims from the old one: the old build's tabs are told
   "superseded" — it was an update.
3. **An older build** with the same migrations and snapshot (an old tab
   reconnecting after a Reset) — the claimant wins ties, so a NEW tab is told
   "superseded".
4. **No SharedWorker** (dedicated fallback, e.g. Chrome Android): every tab's
   worker takes the storage from the previous one.
5. A Reset closes the worker outside the retire lock (`onEnded` → `close()`),
   so a stale tab connecting by the old name in that window can reach the
   closing worker.

## Design

### Ownership: the claim says who claims (host-storage `ownership.ts`)

Claim gains `build` (the worker script's URL — content-addressed, so equal =
same code) and `worker` (its SharedWorker name, `null` for a dedicated one).
The holder answers, in order:

- claimant's migrations ⊉ holder's, or older snapshot → `refuse` (as today) →
  claimant fails `outdated`;
- same build, both shared → `join { worker: holderName }` at once (even while
  booting) unless closing → claimant's boot is declined with the typed refusal
  `{ kind: "join", worker }`: its pages connect to the holder. **A same-build
  worker never takes a serving storage.**
- otherwise (a different build, or no SharedWorker) → yield when answering
  (as today), ending the holder's tabs with `updated` (different build) or
  `unshared` (same build, dedicated workers).

A closing/wiping holder still answers nothing: the claimant waits on the lock
and opens what it left.

### Typed end and refusal reasons (browser-server `port.ts`)

- `HostEndReason = "reset" | "retired" | "updated" | "unshared"` —
  `"superseded"` is gone.
- `HostRefusal = { kind: "outdated" } | { kind: "join"; worker: string }`;
  `HostRefusedError(refusal)` / `PortHostRefusedError.refusal`, wire
  `{ t: "refused", refusal }`. `StorageNewerThanCodeError` becomes a
  `HostRefusedError({ kind: "outdated" })`.
- `demo/scope` maps each by an exhaustive `switch` (tsc fails on a new arm):
  - `reset` / `retired` → follow (reconnect; reset also clears scope storage) —
    no screen;
  - `join` → leave, `generations.join(gen)`, connect to it — no screen
    (redirecting to the very name it came from throws);
  - `updated` / `outdated` → "equin was updated in another tab. Reload this tab
    to continue." + Reload;
  - `unshared` → "This browser cannot share the demo between tabs, and it was
    opened in another one. Reload to continue in this tab." + Reload.

### Generations never reuse a name (demo/prestart `host-generation.ts`)

Store `{ current, highest }`. `advance(from)` → `highest + 1` (a fresh name,
never one some tab used — so a skip never lands on a worker that just
declined with `join`); `join(gen)` sets `current = gen` (the holder is known
to serve it now; if it starts retiring, the skip goes to a fresh name).

### Reset closes under the retire lock (browser-server `serveHost`)

After `ended: "reset"`, a SharedWorker host retires like any other (retire lock
exclusive, then `run`: storage close — idempotent after the wipe — then
`scope.close()`); `onEnded` closes only a dedicated worker. One rule: a
SharedWorker closes only under its retire lock.

## Files

- `framework/browser-server/core/internal/port.ts`, `index.ts` — reasons,
  refusal, reset → retire.
- `framework/browser-server/plugins/host-storage/core/internal/{ownership,open,serve,errors}.ts` — claim identity, join, yield reasons.
- `framework/browser-server/plugins/demo/plugins/prestart/web/internal/{host-generation,prestart}.ts` — `{current, highest}`, `join`, `generationOfWorker`.
- `framework/browser-server/plugins/demo/plugins/scope/web/components/demo-scope.tsx` — follow `join`, exhaustive messages.
- CLAUDE.md of browser-server, host-storage, demo/scope, demo/prestart.

## Verification

- Unit: `shared-host.test.ts` (reset retires under the lock), a new
  `ownership.test.ts` (same build → join; newer build → updated; dedicated →
  unshared; older → outdated; closing → waits), `host-generation.test.ts`
  (fresh names, join), `demo-scope.test.tsx` (join followed, each reason's
  message).
- e2e (`apps/demo/e2e/multi-tab.ts`, new): several tabs opened at once; reload
  while another tab is open; new tab during a Reset; a stale tab after a Reset
  elsewhere — every tab ends on the demo, never a stopped screen, same data.
- Every demo e2e script, `live-demo.ts`, `site-parity.ts`.

## Limits

- Two builds whose workers differ but whose migrations and snapshot are equal
  (a change to worker-side framework code the snapshot's address does not
  cover) have no order: the claimant takes over, and the holder's tabs read
  "equin was updated in another tab". In the usual case the claimant is the
  newer page (a tab loaded after the deploy); an old tab that starts a worker
  after the new one (it reconnects after a Reset) takes it the other way. A
  reload of either tab lands on the current build, which joins.
