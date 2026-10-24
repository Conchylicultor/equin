# Shared prototype option picks (+ a shared agent-write ledger)

## Context

A prototype can declare variants (`<meta name="prototype-option">`), and the
app draws a picker so the user can flip between them. Today the user's picks
live in **browser localStorage** (`useDraft("prototype-options", …)` in
`gallery/web/context.tsx:113`, 90-day TTL). Consequences:

- **Agents can't see what the user picked.** The only channel is one line in
  the Improve button's launch prompt (`launch-rules.ts` `pickedVariantLine`), a
  snapshot from launch time. An agent started any other way, or after the user
  flips a variant mid-conversation, is blind. Its own headless browser has empty
  storage, so its screenshots always show the defaults.
- **Each `*.localhost:9000` origin has its own picks.** Main and each worktree
  deploy disagree. That was "worktree changes don't affect main" by accident,
  not by design.

**Decided target model** (user, 2026-09-15): **one shared record per prototype**,
stored beside the host-global prototype folders. Every UI (main and every
worktree) reads and writes that one record, live, so the selection also follows
the user across browsers and devices. Agents read it from the CLI. To render a
variant without saving anything, agents use the prototype document's own URL
(`…/index.html?palette=azure`), which already works. When an automated browser
session changes picks (an E2E test or a screenshot that clicks the picker), the
change is undone the way config writes are undone today — through that
mechanism, **generalized into a shared primitive** (user's choice over a
picks-only copy). **No pane-URL override**: the pane router keeps only the
path, and the document URL covers the need (user's choice).

## Design

### 1. Picks store — `apps/prototypes/files`

**On disk:** `prototypesDir.subdir("_picks")` → `_picks/<id>.json`, holding the
raw stored picks `{ "palette": "azure" }`. The `_` prefix keeps it out of
`listPrototypeDirNames` (`shared/read-folder.ts`), so it never shows up as a
prototype and never enters the reload signature (`signature.ts`). The backup
source copies the whole dir, so `_picks/` is backed up for free. A missing file
means nothing is picked, which is a legitimate empty answer. A malformed file
throws.

**Shared read/write** in `files/shared/picks.ts` (so the server and the CLI
share one implementation, like `shared/list-metas.ts`):

- `readStoredPicks(id)`: parse with a zod `record(optionName, optionValue)`.
- `writeStoredPicks(id, change)`: read-modify-write under a per-prototype flock.
  Reuse `withHistoryLock(lockPath, fn)` from `shared/history/lock.ts`, with
  `_picks/<id>.lock`. Write with temp + rename, with a `.tmp` suffix so the
  watcher's extension filter skips it (the same as `stampLatest`). A reset
  unlinks the file.
- Store **raw** picks, validated for token grammar only (option name / value
  grammar from `core/options.ts`; `v` reserved). They are not checked against
  the live declaration, because a pick can target an option that only a
  recorded version declares. Every read still goes through `resolvePicks`,
  which judges picks per document (unchanged semantics).

**Contract** in `files/core/picks.ts`:

- `prototypePicksResource = resourceDescriptor<StoredPicks, { name }>("prototypes.picks", …, {})`
  is a push resource keyed per prototype, so it's membership-bounded (point
  shape).
- `setPrototypePicks = defineEndpoint({ route: "PUT /api/prototypes/:name/picks", body: { kind: "set", option, value } | { kind: "reset" } })`.
  It sends one change rather than the whole record, so two surfaces picking
  different options can't overwrite each other.
- Export a token validator from `core/options.ts` (e.g. `isOptionName` /
  `isOptionValue`) instead of re-spelling the grammar.

**Server** (`files/server/internal/picks.ts`):

- `defineExternalResource(prototypePicksResource, { mode: "push", loader })`.
  It follows `prototypeHistoryLiveResource` (`server/internal/history.ts:41`):
  a name that isn't an id, or a missing folder, throws.
- PUT handler: 404 on unknown prototype; `writer = originOf(req)`;
  `picksLedger.record(writer, id, { picks: file }, op)` → write →
  `picksLedger.noteComplete(writer, id)` → `notify({ name })`. The writer
  notifies itself right away. Other backends learn through the watcher.
- `picksLedger = defineAgentWriteLedger({ id: "prototype-picks", label: "Prototype option picks", restore })`.
  `restore` writes `entry.before.picks` back (or unlinks the file) under the
  same lock, then notifies.
- Watcher: extend `classifyTreePath` (`tree-path.ts`) with
  `{ kind: "picks-recorded", id }` for `_picks/<id>.json`, and an internal kind
  for anything else under `_picks/`. In `onTreeEvents` (`watcher.ts`),
  `picks-recorded` → `prototypePicksLiveResource.notify({ name: id })` only.
  There is no version bump, because the prototype's bytes didn't change. The
  frame still reloads, because its `src` changes with the picks. Register the
  route in `server/index.ts`.

### 2. Web — `apps/prototypes/gallery` (+ `present`)

- `context.tsx`: replace `useDraft`/`PICKS_TTL_MS` with
  `useOptimisticResource` (`primitives/optimistic-mutation`) over
  `prototypePicksResource`, where `apply` = set/reset on the record and
  `mutate` = `useEndpointMutation(setPrototypePicks)`. Chips respond instantly,
  and sync-status handles failures. The context exposes `picks` as
  `{ pending: true } | { pending: false, data }`, plus `setPick` and
  `resetPicks`.
- `usePrototypePicks` and `usePrototypeSrc` return the same pending union.
  Picks that aren't known yet are a state to render; defaults never stand in
  for them. Consumers:
  - `prototype-detail.tsx` `StageBody`: fold picks into the existing
    list/version `pending` gate (`Loading variant="block"`).
  - `options-picker.tsx`: render nothing while picks are pending.
  - `detail-actions.tsx` `ImproveButton`: disabled while picks are pending
    (like `list.pending`), and `getRequest` throws "unreachable" if it happens
    anyway (the existing idiom).
  - `present-menu.tsx` `NewTabReady` (disabled item) and `present-overlay.tsx`
    `PresentedFrame` (`Loading`).
  - Compare takes `src` as a prop, so it's unaffected.
- No migration of existing localStorage picks. Picks were a 90-day local
  convenience, so the user re-picks once. The old key expires on its own
  through `useDraft`'s TTL.

### 3. Agents can read and render — CLI + docs

- New verb `./equin prototype options <id>` (`files/cli/options.ts`, lazy,
  declared in `cli/index.ts`; needs no backend). It prints each live option
  with its value, `picked` / `default`, and the declared values. It also
  prints the **document URL of this exact variant**, built with
  `prototypeUrl(id, { picks })` (`core/prototypes.ts:151`) on this checkout's
  origin (reuse `prototypeUrlFormatter`'s namespace resolution in
  `cli/prototype-url.ts`), plus the `screenshot.ts --path …` line that renders
  it without saving anything.
- `prototype list`: add a `picked: palette=azure, …` line under a prototype
  when anything non-default is picked.
- Improve prompt (`launch-rules.ts`): keep `pickedVariantLine` (what the user
  was looking at when they asked), and add "the user may change it; run
  `./equin prototype options <id>` for the current picks".
- `prototypes/CLAUDE.md` § Options: add "Which variant is the user looking at?"
  (the CLI verb) and "Rendering a variant yourself" (the document URL with
  `?<option>=<value>`, via `screenshot.ts --path`; picks are never written).
  There is no agent-facing setter. Picks are the user's.

### 4. Shared agent-write ledger — `infra/request-origin/agent-write-ledger`

Pull config_v2's ledger (`config_v2/server/internal/agent-write-ledger.ts`)
out into `plugins/infra/plugins/request-origin/plugins/agent-write-ledger/`.
It sits under the plugin that defines `WriteOrigin`. Its design doc
(`research/2026-08-30-…-revert-ledger.md`) anticipated this "if a second domain
needs it". This is that second domain.

- **server** `defineAgentWriteLedger<K>({ id, label, restore })` →
  `{ record(writer, key, paths: Record<K, string>, operation), noteComplete(writer, key) }`.
  - The generic file set `Record<K, FileSnapshot>` replaces the fixed
    `DocumentTrio`.
  - `key` is one opaque string (config composes `${scopeId}\0${storePath}`;
    picks use the id).
  - The logic is ported unchanged: first-write-wins `before`, refreshed
    `after`, the divergence check → `diverged`, a failure stays in the ledger,
    and temp+rename `persist`.
  - **Module-level registry, no slot**: `defineAgentWriteLedger` registers at
    its owner's module eval. The ledgers are only read when a request comes in,
    which is after every module has loaded, so load order never matters. (The
    original objection was to a *slot* for a single contributor.)
  - Storage: one file per ledger per runtime namespace,
    `agentWriteLedgerDir.file(runtimeNamespace(), "<id>.json")`. The
    data-dir declaration moves here from `config_v2/data-dirs` (same dir,
    outside anything `forkConfig` copies).
  - Its own `httpRoutes` (the shape of `trash/server/index.ts`):
    `GET /api/agent-writes` → `{ ledgers[{id, label, entries}], lastWriteAt }`,
    and `POST /api/agent-writes/revert` → `{ reverted, diverged, failed }`
    with rows tagged `ledgerId`, `label` and `key`, aggregated over every
    registered ledger.
- **core**: the endpoint definitions and schemas, with no `node:*`.
- **config_v2 migration**:
  - `registry.ts` calls
    `defineAgentWriteLedger({ id: "config", label: "Config documents", restore: applyRestore })`
    once. Its existing record/note call sites (and those in `scope-fork.ts`)
    switch to the returned handle.
  - Delete `agent-write-ledger.ts` and `agent-write-handlers.ts`, the
    `agentWriteLedger` / `revertAgentWrites` / `agentWriteEntrySchema` core
    exports, the `revertAgentConfigWrites` server export, and both routes in
    `server/index.ts`.
  - The primitive depends on nothing in config_v2, so there's no cycle.
  - The legacy `<ns>/ledger.json` is left inert. Every run reverts at its end,
    so it has entries only if a run was killed and nothing has run since.
- **Harness** (`e2e-harness/e2e/agent-writes.ts`, `browser.ts`): import from the
  primitive's core. Rename to `settleAgentWrites` / `repairAgentWrites`, with
  the same start / close → settle → end ordering. Messages name
  `label: key`.
- Docs: config_v2 `CLAUDE.md` § Agent-write ledger points at the primitive;
  request-origin `CLAUDE.md` lists the consumers; the primitive gets its own
  `CLAUDE.md` (limits carried over: no concurrent runs, unmarked clients, and
  secret config fields).

### Known limits (accepted)

- While an E2E run is picking, the user's own view briefly shows that variant.
  It's put back at the end of the run. If the user picks during the run, their
  pick is kept (reported as `diverged`).
- Concurrent E2E runs stay unsupported, as they are today.
- Thumbnails still render the authored defaults. Showing the picked variant on
  gallery cards is a possible follow-up, not part of this.

## Critical files

- New: `plugins/infra/plugins/request-origin/plugins/agent-write-ledger/{core,server,data-dirs}/…`
- New: `plugins/apps/plugins/prototypes/plugins/files/{core/picks.ts, shared/picks.ts, server/internal/picks.ts, cli/options.ts}`
- Modified (files plugin): `files/server/{index.ts, internal/tree-path.ts, internal/watcher.ts}`, `files/core/{index.ts, options.ts}`, `files/cli/{index.ts, list.ts}`
- Modified (web): `gallery/web/{context.tsx, index.ts, components/{prototype-detail,options-picker,detail-actions,launch-rules}.tsx|ts}`, `present/web/components/{present-menu,present-overlay}.tsx`
- Modified (config_v2): `plugins/config_v2/{server/internal/registry.ts, server/internal/scope-fork.ts, server/index.ts, core/index.ts, core/internal/endpoints.ts, data-dirs/index.ts, CLAUDE.md}`
- Modified (harness): `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/{agent-writes.ts, browser.ts}`
- Modified (docs): `prototypes/CLAUDE.md`, `plugins/apps/plugins/prototypes/plugins/files/CLAUDE.md`, `plugins/infra/plugins/request-origin/CLAUDE.md`

## Verification

1. `./equin build` (in the background). The receipt `build-status.json` must read `status: ok`.
2. Unit tests: `./equin test plugins/infra/plugins/request-origin plugins/apps/plugins/prototypes/plugins/files plugins/config_v2`.
   - New ledger tests (none exist today): first-write-wins `before`, a
     divergence is skipped and dropped, a failed restore stays, revert across
     two ledgers.
   - `shared/picks` tests: set, reset, grammar rejection, `v` rejected, a
     malformed file throws.
   - `tree-path.test.ts`: the `picks-recorded` cases.
3. Shared state: open a prototype with options on the worktree deploy and pick a
   value. `_picks/<id>.json` appears. The same prototype open at
   `singularity.localhost:9000` switches live (after main has this code).
   `./equin prototype options <id>` prints the pick and a URL.
4. Render without saving: `screenshot.ts --path "/api/prototypes/<id>/index.html?palette=<v>"`
   renders that variant, and `_picks/<id>.json` is unchanged.
5. Undo: run `gallery/e2e/options-picker.ts`. It passes, the end-of-run line
   reports reverting `Prototype option picks`, and `_picks/<id>.json` has its
   pre-run bytes again (or is absent again).
6. Config undo still works: run an E2E that writes DataView config (e.g. one that
   groups a DataView). It reverts under the `Config documents` ledger. Then
   `./equin check`.
