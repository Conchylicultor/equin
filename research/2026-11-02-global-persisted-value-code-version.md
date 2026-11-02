# Every L2-persisted value carries a version derived from its code

## Context

3b18f63f99 (`research/2026-10-31-global-source-derived-cache-versions.md`)
stamps every L2 definition with the digest of query-resource's `liveReadCode`.
A key whose definition is NULL stays NULL: its stored value is served back to
any later code. On main today (`live_state_snapshot`):

| key | producer | definition |
|---|---|---|
| `notifications.unread`, `saved-themes.list`, `icons.saved-sprites` | `serveValue` `source: "db"` + `preload` (hand-written loader) | NULL |
| `conversations-gone:count` | a collection's compiled `:count` (reach plan, no fingerprint) | NULL |
| every `all` set | compiled, fingerprinted | stamped |

A deploy that changes one of those loaders serves the old value at boot.
Supersedes task-1793459117-69jnv9 (its `all` `v: 1` was fixed by 3b18f63f99).

Goal: no persisted value without a code version, and no version → no
persistence (fail closed), so a stale persisted value cannot be written down.

## Design

### 1. The code of a persisted value is declared where it is served

`Resource.Declare` (server-core) gains `code?: readonly SourceCode[]`: the
modules whose code produces the key's persisted value. A structural shape
(`{ description; urls() }`, which source-digest's `SourceSet` satisfies):
server-core cannot import source-digest (source-digest/server imports
server-core — a cycle).

- **`serveValue`, `source: "db"`, preloaded param-less value** — must pass
  `code: import.meta` (or a list of `import.meta` / `SourceSet`). The serve
  call's module holds the loader expression, so its static closure holds the
  loader's code by construction.
  - tsc: `liveValue` brands a param-less preloaded worktree value
    `persisted: true` (a real field, like `preloadsParams`), and the db
    `PlainValue` overloads split on it: branded ⇒ `code` required; otherwise
    `code?: never` (external values too — never persisted).
  - throw for an untyped caller (branded db value without `code`, or `code`
    anywhere else).
  - normalized into one `SourceSet` (`serveValue("<key>")'s loader`) plus the
    sets passed.
- **`serveCollection` `all` set** — `code: [liveReadCode]` (its definition
  pins the declaration; `liveReadCode` the compiler).
- **`:count`** — no `code`, so never persisted (one `count(*)` at boot). It
  has no fingerprint of its SQL, so it cannot be versioned yet.
  Window / `:rows` / union Declares are bounded and never persisted anyway.
- **Registry-reached code**: `icons.saved-sprites` calls every
  `defineSavedIconSource`'s `names()`, code outside its closure.
  `defineSavedIconSource` now takes `code: import.meta` and adds it to
  `savedIconSourcesCode` (saved-sources server); the sprites value passes
  `code: [import.meta, savedIconSourcesCode]`.

### 2. live-state-snapshot stamps each key with its own code

- `L2CodeStamp({ stamp })` becomes `L2CodeDigest({ digest(code) })` (machine:
  `sourceDigest`). `resolveCodeStamps()` (init, before hooks are installed)
  digests every candidate key's code (memoized per set by source-digest; all
  sets prewarmed at boot).
  - No provider (browser host) ⇒ one per-process stamp, as today.
  - Two providers ⇒ throw ⇒ L2 off for the boot, as today.
  - One key's digest failing ⇒ that key is not persisted this boot (reported
    once); the others are.
- `shouldPersist(key)` = preloaded, no `preloadTuples`, **and a resolved
  stamp** (so a Declare with no `code` is never persisted, written or served).
- `stampDefinition(key, definition)` = `sha256(stamp(key) ‖ definition ?? "")`
  — never NULL for a persisted key. Written by the persist hook,
  expected by `l2Expectation`, which now covers every `persistedKeys()` entry
  (not only `persistedDefinitions()`).
- Rows on disk with a NULL definition are unusable from here on: swept and
  recomputed once.
- The epoch handoff keeps `liveReadDigest` unchanged.

## Critical files

- `plugins/framework/plugins/server-core/core/resources.ts` (Declare payload)
- `plugins/network/plugins/live/core/internal/live-value.ts` (`persisted` brand)
- `plugins/network/plugins/live/server/internal/{serve-value,serve-collection}.ts`
- `plugins/database/plugins/live-state-snapshot/{machine/index.ts,server/internal/{code-stamp,persist,expectation,boot-init}.ts}`
- `plugins/packages/plugins/source-digest/server/internal/digest.ts` (accept the structural shape)
- `plugins/ui/plugins/icons/plugins/saved-sources/server`, the 6 `defineSavedIconSource` sites
- call sites: `shell/notifications/server/internal/resources.ts`,
  `ui/theme-engine/saved-themes/server/internal/resource.ts`,
  `ui/icons/sprites/machine/internal/saved.ts`
- docs: live-state-snapshot, network/live, source-digest CLAUDE.md

## Verification

- `./equin test plugins/database/plugins/live-state-snapshot` — code-stamp:
  per-key stamps differ by code, a NULL definition is stamped, a failed digest
  excludes only its key, no provider ⇒ per-process.
- `./equin test plugins/network/plugins/live` — serveValue throws without
  `code` on a preloaded db value and with `code` elsewhere; Declare carries it.
- `./equin build`, `./equin check`; then `query_db`: no NULL `definition` rows
  for persisted keys after boot, and the boot log shows no L2 degradation.
