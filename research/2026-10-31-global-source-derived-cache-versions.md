# Cache versions derived from source, not bumped by hand

## Context

Two caches trust state across a restart under a version a human must remember
to bump when the code that produced the state changes:

1. **`POINT_DEFINITION_VERSION`** (`infra/query-resource/server/internal/point-definition.ts`).
   The epoch handoff (resource-runtime `resumeEpoch`, live-state-snapshot
   `handoff.ts`) lets a successor answer `up-to-date` for a `:rows` tuple its
   predecessor served, if the entry's point definition is equal. The definition
   pins the rendered SQL, decoder ids, row schema, `maxIds`, `encodeRowId` — not
   the compiler / codec CODE (the point loader, decoders, the `$columns` fold).
   A change to that code with no bump hands stale rows to open tabs.
2. **corpus-index `version`** (`infra/corpus-index`). Since the boot walk became
   an FSEvents journal catch-up, a `match`/`parse` change is no longer repaired
   by the next boot's walk; only a `version` bump rebuilds. Today it is
   documented in CLAUDE.md (rung 5).

Goal: the version is **derived from the code it depends on**, so a stale cache
has no spelling (rung 1).

## Measurements (2026-10-31, host at load ~170, so inflated)

Static runtime import closure (type-only imports are erased by the transpiler,
so they don't count):

| Entry module | Files | npm |
|---|---|---|
| `stats/cost/server/internal/usage-index.ts` (the cost parse) | 6 | 1 |
| `query-resource/server/internal/compile-window.ts` (point loader) | 163 | 6 |
| `query-resource/server/index.ts` | 171 | 6 |
| `sonata/…/folders/server/internal/reconcile.ts` (MIDI index today) | 625 | 18 |

Of 353 main commits in the last 7 days, 44 touched the compile-window closure:
a closure-derived point code version would cost ~12% of deploys their handoff
— the price of correctness by construction. A whole-server (build id) version
would cost 100%, hence per-closure.

## Design

### 1. `packages/source-digest` — a module's code, as a digest

- **core** (portable, pure data): `defineSourceSet(description)` →
  `{ include(meta: ImportMeta), urls() }`, every set kept in a module-level
  registry (`allSourceSets()`). `include` takes **`import.meta` itself**: a
  module can only hand over its own, so "the module this code lives in" has no
  wrong spelling (no lint needed).
- **server** (desktop-only, `no-platform-api` exemption *sanctioned*: it reads
  the checkout's own source): `sourceDigest(sets) → Promise<string>`, sha256
  over the union of the sets' modules' static runtime import closures, walked
  with `Bun.Transpiler.scanImports` + `Bun.resolveSync` (`@plugins/*` resolves
  exactly as the runtime does):
  - a repo file → its path relative to the closure's common ancestor dir (so
    main and a worktree with the same code agree) + its bytes' sha256; code
    files recursed;
  - a file under `node_modules` → `pkg:<name>@<version>` (nearest
    `package.json`), not recursed; a builtin → its specifier;
  - an import that does not resolve throws (loud); a set with no module throws;
  - async reads, a macrotask yield per file; memoized per module set for the
    process (held as a settled result, so an unasked failure is no unhandled
    rejection).
  - **Eager at boot** (serving backends only): the plugin's `onReadyBlocking`
    starts (does not await) every defined set's digest, so a digest describes
    the files as close as possible to when they were imported.
- No host service: both consumers are desktop-only — corpus-index (already a
  non-portable `server/`) and the epoch handoff, whose hooks move to
  live-state-snapshot's `machine/` half (a browser host has no successor
  process). So no browser-host provider is needed.

### 2. corpus-index: `format` replaces `version`

- corpus-index **core**: `corpusFormat(import.meta, { match, parse? })` →
  `CorpusFormat<T>` (overload: no `parse` ⇒ `CorpusFormat<null>`), backed by a
  source set including that module. `match`/`parse` are expressions in that
  module, so they are in its closure by construction.
- `CorpusIndexSpec`: `format` replaces `match` / `parse` / `version`. The index
  file's `version` becomes the format's digest (string); a mismatch rebuilds,
  as before.
- Consumers move the format into a SMALL module so the closure is the parse,
  not the whole plugin:
  - cost: `usage-index.ts` exports `transcriptFormat` (delete `INDEX_VERSION`);
  - MIDI: new `server/internal/midi-format.ts`.
- `createCorpusIndex` takes the digest through its `env` (tests stub it).

### 3. The handoff: a record-level code digest

- query-resource **core** exports `liveReadCode = defineSourceSet(…)`:
  "the code that shapes what a point read's load produces".
  - `compile-window.ts` includes itself (its closure: the point compile,
    arm-plan, raw-sql, sql-projection / sql-column decoders, zod by version);
  - network/live moves `encodeRow` / `encodeRowId` construction out of
    `serve-collection.ts` into a small `encode-row.ts` that includes itself.
- live-state-snapshot `handoff.ts`: the record gets a `code` column
  (imperative DDL `ADD COLUMN IF NOT EXISTS`, like the table's other
  upgrades). The writer stores `digest(liveReadCode)`; the loader computes its
  own and returns no record (logged: `code changed`) when they differ or either
  is missing (a record written before the column: NULL). Both are injected deps, so `handoff.test.ts` drives them.
- Delete `POINT_DEFINITION_VERSION` and its "bump" docs.

### 4. The L2 `all` definition (folded in at the supervisor's request)

`compile-alias.ts`'s definition carried a hand-written `v: 1` — same class.
`pointReadCode` became `liveReadCode` (`compile-window.ts`, `compile-alias.ts`,
`encode-row.ts`, whose `foldColumns` the `all` arm now shares). live-state-
snapshot stamps every definition it writes or expects with
`sha256(stamp ‖ definition)`; the stamp is the `liveReadCode` digest, provided
by its `machine/` half as an `L2CodeStamp` contribution (collected before any
`onReadyBlocking`, so the portable half can read it in its own even though the
machine half boots after it). No provider (browser host) ⇒ a per-process stamp.
A failed digest ⇒ L2 off for the boot. `v: 1` deleted.

### 5. Failing closed

- A digest is awaited, never read half-done.
- A throw (unresolvable import, unreadable file) means "no match" for every
  consumer: no handoff, L2 off, the corpus-index read fails.
- An `import(x)` / `require(x)` whose path is not a literal throws — no
  escape (code reached through one is not hashed, so a mark would fail open).
  The live-read closure (170 files) had exactly one: server-core's
  `boot-stages.ts` warming core barrels by template path, reached through the
  core barrel's `bootBrowserHost`. It now takes its loaders from the
  composition root (`BootSpec.coreBarrel`, `bin/active-runtime.ts`), outside
  every guarded closure.

## Still unversioned

Hand-written persisted values (`serveValue` `source: "db"` with `preload`)
persist with a NULL definition: their loader code has no version at all.

## Critical files

- new `plugins/packages/plugins/source-digest/{core,server,exempt}`
- `plugins/infra/plugins/corpus-index/{core,server/internal/corpus-index.ts,CLAUDE.md}`
- `plugins/stats/plugins/cost/server/internal/{usage-index,load-usage,cost-report-kinds}.ts`
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/server/internal/reconcile.ts`
- `plugins/infra/plugins/query-resource/{core,server/internal/point-definition.ts,server/internal/compile-window.ts,CLAUDE.md}`
- `plugins/network/plugins/live/server/internal/{serve-collection,encode-row}.ts`
- `plugins/database/plugins/live-state-snapshot/{machine/index.ts,server/index.ts,server/internal/handoff.ts,server/internal/tables-ddl.ts}`

## Verification

- `./equin test plugins/packages/plugins/source-digest` — a transitive edit
  moves the digest, an unrelated or type-only one does not, the same code at two
  paths digests equal, an unresolvable import throws.
- `./equin test plugins/infra/plugins/corpus-index plugins/database/plugins/live-state-snapshot plugins/infra/plugins/query-resource`
  — format digest mismatch rebuilds; a handoff record under another code
  digest loads as none.
- `./equin build`, then `./equin check`; after the build, the backend log shows
  the handoff written/loaded and the cost/MIDI indexes rebuilt once (the stored
  numeric versions no longer match a digest).
