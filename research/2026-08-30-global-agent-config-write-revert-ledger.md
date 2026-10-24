# Agent-write revert ledger for config_v2

Date: 2026-08-30 · Category: global (e2e-harness + config_v2 + infra)

> **Update 2026-09-16 — generalized.** A second domain (prototype option picks)
> needed the same undo, so the ledger moved out of config_v2 into the shared
> `infra/request-origin/agent-write-ledger` primitive: `defineAgentWriteLedger`
> with a named file set per entry, one file per ledger
> (`<namespace>/<id>.json`), and `GET /api/agent-writes` /
> `POST /api/agent-writes/revert` aggregating every ledger. The capture, divergence
> and restore logic below is unchanged; config_v2 is now one ledger
> (`"config"`). The `/api/config-v2/agent-writes*` routes and `<ns>/ledger.json`
> described below are gone. See
> [`2026-09-16-global-shared-prototype-option-picks.md`](2026-09-16-global-shared-prototype-option-picks.md) § 4.

## Context

A DataView writes its per-view-instance `sort` / `filter` / `groupBy` straight back through
config_v2 into the **durable user layer** — `~/.singularity/state/config/<worktree>/<plugin>/<id>.jsonc`,
via `setConfig("views", …)` with no `scopeId`
(`primitives/data-view/plugins/view-core/web/internal/use-views-config.ts`, 400 ms trailing debounce).
That is the feature working as designed.

The consequence is that **an e2e script that clicks "Group by Kind" to verify grouping works
leaves the running surface grouped for the user**, and the next person to open that surface finds
it that way. The repo-committed `config/**` is never touched, only the user layer, which is what
makes it easy to miss.

It also poisons the script's own next run. Hit for real while verifying the merged **Runs**
surface: with grouping residue already in place, the baseline for "grouping renders collapsible
sections" started at 44 `[aria-expanded]` elements instead of 0, so the assertion saw 44 → 44 and
failed, and the restore step then read a third number. A test that corrupts its own next baseline
is worse than one that simply fails, because the failure looks like a product bug.

Today the only mitigation is a hand-written teardown block in `plugins/build/e2e/runs-surface.ts`
(line 303, `// TEARDOWN, and not optional`). It works, but it is **discipline, not structure** —
the next e2e to drive any DataView leaves the same residue. There are 157 e2e scripts.

**Intended outcome:** a config write made by an automated browser session is *recorded* and
*automatically undone*, at both ends of every run, with nothing to opt into and nothing to
remember — the same shape as the agent-origin provenance already in the harness.

## Why this shape

The harness **already** stamps every browser context with provenance (`e2e/browser.ts:180-185`):

```ts
extraHTTPHeaders: {
  "x-singularity-origin": "agent",
  "x-singularity-origin-source": originSource(),   // "e2e:runs-surface"
}
```

That signal exists because of
[`research/2026-07-29-global-agent-origin-provenance-for-pages.md`](2026-07-29-global-agent-origin-provenance-for-pages.md),
which used it to mark, segregate and sweep agent-created *pages*. This plan is the same signal's
second consumer, and it resolves two things that doc left open:

- It recorded **"No teardown"** as a deliberate non-goal, because per-script cleanup *"never runs
  on SIGKILL / Playwright timeout / Ctrl-C — the normal ways these runs end"*. Answered
  structurally here: the ledger is durable and the revert runs at the **start** of the next run as
  well as the end of this one, so a killed run is repaired rather than forgotten.
- It deferred an AsyncLocalStorage origin primitive until *"a second consumer appears that
  genuinely can't see `req`"*. We still do not need it — see §2.

Two alternatives were considered and rejected:

- **An agent config scope.** Stronger in principle (the write never addresses the user layer),
  but config scopes are a *dimension*, not a stack: `scopeSegment` (`server/internal/scope-paths.ts:13`)
  throws on any kind but `app`, discovery only walks `@app`, and `agent:<src>` could not compose
  with the `app:<id>` scope a DataView already sits in. The flat `<kind>:<id>` grammar has no
  spelling for both.
- **Blunt whole-layer snapshot/restore in the harness.** Cannot tell an agent write from a user
  one, so it stomps a setting changed in the user's own browser mid-run, and it restores *behind
  the server's back* — which config_v2's own CLAUDE.md forbids relying on: the `CONFIG_DIR`
  watcher is *"a push-latency mechanism, not a correctness one … never treat 'no event' as 'no
  change'"*.

## The finding that shapes §6 — `finally` is not "always on"

**Verified, and it invalidates the obvious implementation.** `report().finish()` ends in
`process.exit()` (`e2e/report.ts:140,145`), which **skips `finally`**. And of the 136 scripts
using `withBrowser`, **86 call `finish()` inside the `withBrowser` callback** (e.g.
`plugins/release/e2e/release-boot-verify.ts` — callback opens :96, `r.finish()` :258, closes :259).

So a `finally`-based revert would run for roughly 50 of 136 scripts, not all of them.

The same defect already bites today: `await browser.close()` in `withBrowser`'s `finally`
(`browser.ts:172`) **does not run for those 86 scripts either**, despite that file's docblock
claiming `withBrowser` "fixes that for every caller at once" by closing the browser in a
`finally`. Every one of those runs leaks its Chromium process.

Fixing this is therefore a prerequisite for the revert *and* worth doing on its own merits. It is
also a genuine scope increase — see §6.

## Design

### 1. One spelling for the provenance header — a new leaf primitive

The two header names are written out in three places today (`e2e/browser.ts:183-184`,
`apps/pages/plugins/agent-origin/server/internal/create-hook.ts:10-11`, and prose in
`page/plugins/markdown-apply/server/internal/apply.ts:84`). A third consumer makes that a
"these must agree" invariant with no enforcement, so single-source it first.

**New leaf plugin `plugins/infra/plugins/request-origin/core/`** — imports nothing, so every
runtime that needs it can reach it (the boundary config grants `e2e: ["e2e", "core", "data-dirs"]`,
so the harness can import it too and stop hardcoding the headers):

```ts
/** Who caused a durable write. Discriminated so "agent" carries its script and
 *  "system" carries its reason; a boolean could carry neither. */
export type WriteOrigin =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly source: string }
  | { readonly kind: "system"; readonly reason: string };

export const ORIGIN_HEADER = "x-singularity-origin";
export const ORIGIN_SOURCE_HEADER = "x-singularity-origin-source";

/** The ONLY place the header is interpreted. */
export function originOf(req: Request): WriteOrigin { … }
/** A write with no request behind it — a job, boot propagation, a CLI verb. */
export function systemOrigin(reason: string): WriteOrigin { … }
```

Migrate `pages/agent-origin`'s create-hook onto it in the same change (behaviour unchanged; it
stops spelling the headers itself).

### 2. Provenance is threaded, not ambient

The config write surface is small and already funnelled: the five mutating `*ByPath` functions in
`config_v2/server/internal/registry.ts` are called from exactly one file
(`config_v2/plugins/settings/server/internal/handlers.ts`), the four scope functions from one more
(`config_v2/server/internal/scope-handlers.ts`), and all of those handlers already receive `req`
from `implement()`'s ctx. A **required parameter** puts the guarantee on rung 2 — a new handler
that forgets is a `tsc` error — where ALS would leave a write path outside the context silently
unattributed.

Pass it as a **required options object**, replacing the trailing optional `scopeId`. Appending a
5th positional parameter would compile while forcing every caller to restate `scopeId`; the object
makes both omissions a type error and kills the positional-`scopeId` footgun at the same time:

```ts
// registry.ts — `origin` here is the WriteOrigin type; inside config_v2 the
// PARAMETER is deliberately not named `origin` at the file level (see below).
export interface ConfigWriteOpts {
  /** REQUIRED. `originOf(req)` at an HTTP boundary; `systemOrigin("…")` otherwise. */
  writer: WriteOrigin;
  scopeId?: string;
}

export async function setConfigByPath(storePath: string, key: string, value: unknown, opts: ConfigWriteOpts): Promise<void>
export async function resetConfigByPath(storePath: string, key: string, opts: ConfigWriteOpts): Promise<void>
export function acknowledgeConflictByPath(storePath: string, opts: ConfigWriteOpts): void
export function deleteOverrideByPath(storePath: string, opts: ConfigWriteOpts): void
export function mergeConflictByPath(storePath: string, opts: ConfigWriteOpts): { resolved: boolean; conflictKeys: string[] }
// scope-fork.ts: forkScope / deleteScope / forkDescriptorScope / removeDescriptorScope
//   each take { writer: WriteOrigin }
```

**The field is `writer`, not `origin`.** config_v2 already uses "origin" for the `.origin.jsonc`
layer, and its CLAUDE.md calls that collision out by name (it is why descriptors carry `source`).

`setConfigByPath` / `resetConfigByPath` forward `opts` to `setConfig` unchanged, so the writer
cannot be dropped in the middle. Call sites are three files: the two above, plus three `setConfig`
calls in `plugins/auth/plugins/apple-signing/server/internal/certificate-endpoint.ts:83-112`.

### 3. The ledger

**Where it lives:** `plugins/config_v2/server/internal/agent-write-ledger.ts`, *not* a sub-plugin.
The two halves point at each other — `registry.ts` must call the recorder, and the reverter must
call `refreshEntry` (:167), `getEntry` (:338), `ensureScopeEntry` and `disposeScopeEntry`, all
**module-private to `registry.ts` today**. That is a cycle `detectCycle`
(`tooling/plugins/boundaries/core/check.ts:200`) rejects, and the existing sibling
`config_v2/plugins/settings` is a clean leaf precisely because nothing imports it back. A
contribution slot would break the cycle, but CLAUDE.md reserves slots for *genuinely open* sets and
this one has exactly one contributor forever — and it would make plugin load-wave ordering
load-bearing (a write before the child registers would go unrecorded).

**Capture the whole trio, not just the override.** The write paths mutate three files between
them: `forkDescriptorScope` writes both the scoped `<name>.origin.jsonc` **and** `<name>.jsonc`
(`scope-fork.ts:35-43`, verified); `removeDescriptorScope` unlinks both and rmdirs the scope dir;
`deleteOverrideByPath` unlinks override + ancestor (:838-841); the conflict resolvers rewrite the
override and unlink the ancestor. Capturing one file would miss half of them. Capturing
`{ origin, override, ancestor }` uniformly is correct for every existing path *and* every future
one, with no per-operation knowledge.

```ts
type FileSnapshot = { present: false } | { present: true; bytes: string };
interface Trio { origin: FileSnapshot; override: FileSnapshot; ancestor: FileSnapshot }

interface LedgerEntry {
  storePath: string;
  scopeId: string;              // "" = base
  /** Absolute, captured at record time, so a restore never needs the descriptor
   *  to still be registered (renamed or removed between run and revert). */
  paths: { origin: string; override: string; ancestor: string };
  before: Trio;                 // as it stood BEFORE the first agent write — what revert restores
  after:  Trio;                 // as the LAST agent write left it — what detects a user edit on top
  source: string;               // "e2e:runs-surface"
  operations: string[];         // ["set-field:views", …] — diagnostics only
  firstWriteAt: string; lastWriteAt: string;
}
```

**Why the FIRST write is the one captured.** The ledger answers "what did this look like before
the agent touched it". On a second write the pre-write bytes *are the agent's own first write*, so
capturing them would revert to an intermediate agent state. `before` is first-write-wins; `after`
is refreshed every write. Bytes, not parsed content — so the `// @hash` header comes back
byte-identical and no re-serialisation can drift (config_v2 treats a hashless file as corrupt).

**On disk — its own declared data dir, deliberately NOT inside `configDir`.** `forkConfig`
(`config_v2/server/internal/fork.ts`) recursively copies main's config tree into every new
worktree; a ledger living there would be inherited by a fresh worktree whose first start-repair
would then "revert" files that are legitimately in place. So add a second `defineDataDir` to
`plugins/config_v2/data-dirs/index.ts` (`agent-write-ledger`, `reclaim: never`) and address it as
`agentWriteLedgerDir.file(worktree, "ledger.json")` — never a hand-written path
(`paths:no-hardcoded-paths`). Rewritten whole on each mutation via temp-file + `renameSync`, so it
can never be half-parsed after a SIGKILL.

### 4. The revert

`revertAgentWrites()` in the ledger module; the per-entry apply step lives beside the private
registry helpers it needs. Per entry, in order:

1. **Divergence check.** Compare current disk bytes against `after`. Any difference means someone
   else wrote the document after the agent did — **do not restore**, or the user's edit is
   destroyed. Report it in `diverged` and drop the entry (the user has taken ownership; retrying
   forever is worse).
2. **Restore.** Per role: `present: true` → atomic raw byte write; `present: false` → unlink if
   present. A new `writeRawAtomic(path, bytes)` beside `jsoncConfigProxy` in `jsonc-proxy.ts`.
3. **Reconcile through the registry's own path, never behind it.** Base scope → `refreshEntry`.
   Scoped → `disposeScopeEntry`, then `ensureScopeEntry` if either scoped file now exists, then
   the scope-change notify — mirroring `forkDescriptorScope` / `removeDescriptorScope` exactly, so
   a reverted fork leaves the cache where those functions would. This is why revert goes through
   the server rather than the filesystem: the in-memory cache and every subscribed browser update
   deterministically instead of waiting on a watcher event that may never arrive.
   Descriptor no longer registered → the bytes are already back; note it and skip the refresh
   rather than throwing.
4. **Clear only what succeeded.** Reverted and diverged entries are removed; entries that **threw
   stay in the ledger** so the next start-repair retries them.

Failures are never swallowed — each entry is wrapped individually so one bad document cannot
strand the rest, and the outcome is a discriminated result, not an absorbable empty value:

```ts
interface RevertOutcome {
  reverted: { storePath: string; scopeId: string; source: string }[];
  diverged: { storePath: string; scopeId: string; detail: string }[];
  failed:   { storePath: string; scopeId: string; message: string }[];
}
```

The endpoint returns this; **the harness throws when `failed.length > 0`**, so exactly one place
has to get that check right and it is in the harness, not in 157 scripts.

### 5. Two endpoints

In `plugins/config_v2/core/internal/endpoints.ts`, re-exported from `plugins/config_v2/core` — the
barrel the `e2e` runtime is permitted to import.

- `GET /api/config-v2/agent-writes` → `{ entries, lastWriteAt: string | null }`. `lastWriteAt` is
  the quiescence signal the harness polls (§6).
- `POST /api/config-v2/agent-writes/revert` → the `RevertOutcome` above. No body; revert-all is the
  whole contract, and it is idempotent (an empty ledger returns three empty arrays).

Handlers in `config_v2/server/internal/agent-write-handlers.ts`, routed from
`config_v2/server/index.ts` beside the four existing scope routes.

### 6. The harness change — and its rider

**First, the prerequisite.** `finish()` must become the teardown chokepoint, because it is the
real exit path for 86 of 136 scripts:

```ts
// report.ts
const beforeFinish: Array<() => Promise<void>> = [];
/** Async work that must happen before the verdict prints and the process exits.
 *  finish() ends in process.exit(), so a caller's `finally` is NOT such a place. */
export function onBeforeFinish(fn: () => Promise<void>): () => void { … }

async finish(): Promise<never> {
  for (const t of beforeFinish.splice(0)) {
    try { await t(); }
    // A failed revert must NOT be followed by ALL CHECKS PASSED — same reasoning
    // as asyncFailures: a green script gets cited as evidence.
    catch (err) { record("harness teardown", String(err)); }
  }
  failures.push(...asyncFailures);
  /* …unchanged summary + process.exit… */
}
```

**The rider is 154 call sites.** Changing `finish(): never` to `finish(): Promise<never>` makes
every one of the 154 bare `r.finish();` statements (verified; none is awaited today) a floating
promise, which the repo's already-enabled `no-floating-promises` rule errors on. So
`./equin check type-check` fails until each becomes `await r.finish()` — a mechanical
one-line change per file, **verified by the type checker rather than by review**. `await` on
`Promise<never>` still narrows to `never`, so no control-flow reasoning changes.

Sequence it as its own first step. It stands on its own: it is the same defect that leaks a
Chromium process on every one of those 86 runs today.

**Then `withBrowser`:**

```ts
export async function withBrowser<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  // START REPAIR — before chromium.launch(), so nothing this run reads can be a
  // baseline poisoned by a previous run killed before its own revert. This is the
  // half no teardown can provide, and it runs on the normal path, not in a finally.
  await repairAgentConfigWrites("start");

  let browser: Browser;
  try { browser = await chromium.launch({ headless: !flag("headed") }); }
  catch (err) { throw launchFailure(err); }

  let torndown = false;
  const teardown = async () => {
    if (torndown) return;
    torndown = true;
    // ORDER IS LOAD-BEARING. Close first: a pending DataView write lives in a
    // setTimeout inside the page, so closing the context kills the timer and
    // bounds what can still reach the server to what is already dispatched.
    // Then drain those. Then revert.
    await browser.close();
    await settleAgentConfigWrites();      // poll lastWriteAt until quiet (750ms > the 400ms debounce), cap 5s
    await repairAgentConfigWrites("end");
  };
  const release = onBeforeFinish(teardown);
  try { return await fn({ browser, session: … }); }
  finally { release(); await teardown(); }
}
```

Both exit paths are covered and both are loud: `finish()` inside the callback turns a teardown
failure into a `FAIL harness teardown` line and exit 1; `finish()` outside means the teardown
throws out of `withBrowser`, the top-level `await` rejects, and the process exits non-zero.

The HTTP call lives in a new `e2e/agent-writes.ts`, building the URL from the imported
`EndpointDef`'s own `.method` / `.path` rather than retyping the route, and decoding via its
`responseCodec`. Raw `fetch("/api/…")` is banned in `/web/` only
(`endpoints:typed-web-fetches` filters on `path.includes("/web/")`), so `e2e/` is clear.

### 7. Delete the hand-rolled teardown

`plugins/build/e2e/runs-surface.ts:303-323` — remove the `TEARDOWN` block and its restore
assertion; keep the group-by verification above it. Its `before` baseline becomes trustworthy for
the first time, because start-repair guarantees it is the user's real state.

### 8. Guards

- **`agent-origin-safety/no-unmarked-app-fetch` (lint).** *(shipped)* The biggest remaining hole: `extraHTTPHeaders`
  marks only requests issued *by the browser context*. An e2e script's own Node-side
  `fetch(`${base}/api/…`)` — ~15 exist today — carries no provenance, so a config write made that
  way is invisible to the ledger. Add `agentFetch()` to the harness (attaching the headers from
  `request-origin/core`) and a rule firing on a bare `fetch()` at a `pathUrl(...)`/`` `${base}/api/…` ``
  argument inside `e2e/`. Exact precedent in shape and justification:
  `tooling/plugins/lint/plugins/route-teardown-safety/lint/no-unroute.ts`, which is
  `enforceEverywhere` specifically so it reaches `e2e/` files.
- **`e2e-harness:browser-through-harness` (check).** *(shipped)* No `chromium.launch(` outside the harness.
  `withBrowser` is only a guarantee while it is the only way in; today it is (verified across all
  157 scripts). An added entry to the plugin's existing `check/index.ts`, not new machinery.

No rule against hand-rolled config teardown: "teardown" has no syntactic signature, a rule broad
enough to catch it would also catch legitimate cleanup of *app* state, and the motive is gone once
the revert is structural.

## Files

| Path | Change |
|---|---|
| `…/e2e-harness/e2e/report.ts` | `onBeforeFinish`; `finish()` → `Promise<never>` |
| **154 e2e scripts** | `r.finish();` → `await r.finish();` (mechanical, enforced by `no-floating-promises`) |
| `plugins/infra/plugins/request-origin/core/**` | **new leaf plugin** — headers, `WriteOrigin`, `originOf`, `systemOrigin` |
| `apps/pages/plugins/agent-origin/server/internal/create-hook.ts` | drop its header literals; import the primitive |
| `config_v2/server/internal/agent-write-ledger.ts` | **new** — trio capture, persistence, revert |
| `config_v2/server/internal/agent-write-handlers.ts` | **new** — the two handlers |
| `config_v2/server/internal/registry.ts` | `ConfigWriteOpts`; required `writer` on the five `*ByPath`; record call per write; expose the revert apply step |
| `config_v2/server/internal/jsonc-proxy.ts` | `writeRawAtomic(path, bytes)` |
| `config_v2/server/internal/scope-fork.ts` | `{ writer }` on the four scope fns |
| `config_v2/plugins/settings/server/internal/handlers.ts` | destructure `req`; pass `originOf(req)` |
| `config_v2/server/internal/scope-handlers.ts` | same, four handlers |
| `auth/plugins/apple-signing/server/internal/certificate-endpoint.ts` | three `setConfig` calls get a writer |
| `config_v2/core/internal/endpoints.ts` + `core/index.ts` | the two contracts |
| `config_v2/data-dirs/index.ts` | `agentWriteLedgerDir` |
| `config_v2/server/index.ts` | route the two handlers |
| `…/e2e-harness/e2e/agent-writes.ts` | **new** — settle + repair + `agentFetch` |
| `…/e2e-harness/e2e/browser.ts` | start-repair, teardown registration, revert-after-close |
| `…/e2e-harness/check/index.ts`, `…/lint/**` | the two guards |
| `plugins/build/e2e/runs-surface.ts` | delete the teardown block (:303-323) |
| `config_v2/CLAUDE.md`, `…/e2e-harness/CLAUDE.md` | the ledger, the always-on revert, the no-parallel-runs rule |

## Trade-offs and known limits

1. **The 400 ms debounce, decomposed.** *Timer not yet fired at close* → closing the context
   destroys it, so the write never happens (note `use-views-config.ts:171`'s flush-on-unmount is a
   React hook; a page close is not an unmount — so a last-400 ms edit is silently lost, not raced).
   *POST in flight at close* → the server may still execute it; this is why close comes first and
   the settle polls `lastWriteAt` until quiet. *Write lands after the revert anyway* → not
   eliminable, but it degrades gracefully: the late write creates a new ledger entry whose `before`
   is what revert just restored, and the **next start-repair** undoes it. Worst case is "mutated
   until the next e2e run", never "mutated forever" — and the poisoned-baseline bug is gone
   regardless, because every baseline is now read after a start-repair.
2. **A concurrent user edit is detected, not stomped.** The `after` snapshot is what makes this
   safe: revert skips any document whose bytes moved since the agent's last write and reports it as
   `diverged`. The cost is that the agent's edit is then frozen in — correct, because the user
   demonstrably touched that document.
3. **`screenshot.ts --click` drives revert too.** Deliberate — a screenshot drive should not change
   the user's settings. The supported way to change config remains editing `config/**.jsonc`.
4. **Do not run two e2e scripts concurrently.** Revert-all is what lets a run repair one it did not
   launch; the price is that script A's end-revert would restore script B's in-flight writes. The
   `source` field is recorded per entry, so a `--only-mine` filter is a body field away, but it
   would give up cross-run repair. State the rule in the harness CLAUDE.md.
5. **Secret / provider-backed fields are structurally un-ledgerable.** `setConfig` returns at
   `registry.ts:513-524` for any field with a `FieldStorageProvider`, never touching the JSONC
   layer, so a bytes ledger cannot see it. A real hole in "always on" — say so plainly in the
   CLAUDE.md rather than papering over it; covering it would need a second, provider-side ledger.
6. **Raw `curl` is unmarked**, as the original agent-origin doc already states.
7. **Config only.** Durable agent writes to the DB (tasks, conversations) are out of scope; pages
   have their own sweep. A general durable-write ledger is a much larger design — a follow-up task
   if a second domain needs it.

## Verification

1. `./equin build` (background), then confirm `status: ok` in
   `~/.singularity/worktrees/<wt>/build-status.json`.
2. **The original bug.** Confirm no override exists: `ls ~/.singularity/state/config/<wt>/runs/`
   shows `runs.origin.jsonc` and no `runs.jsonc`. Run
   `./equin run plugins/build/e2e/runs-surface.ts`. It passes, and `runs.jsonc` is still
   absent afterwards.
3. **Determinism.** Run it again immediately. The `aria-expanded ${before} → ${after}` line must
   report the *same* `before` — that number drifting was the original failure.
4. **The 86-script path.** Run a script that calls `finish()` inside the callback (e.g.
   `plugins/release/e2e/release-boot-verify.ts`) and confirm the revert ran — this is the case a
   `finally` would have missed. Confirm no orphaned Chromium process survives it.
5. **Kill-mid-run repair.** Ctrl-C the runs script just after the group-by click. Confirm
   `runs.jsonc` now exists and `ledger.json` is on disk; re-run and confirm start-repair fixes it.
6. **Divergence.** With a ledger entry pending, hand-edit the same file, then trigger a revert;
   confirm it is reported as `diverged` and the hand edit survives.
7. **The write really happens.** With `--headed`, watch the surface actually group before the
   revert — proving this isolates rather than suppresses the write.
8. `./equin check` — `type-check` proves both the `writer` threading and the `await
   finish()` migration have no missed call site; the two new guards run clean.
