# source-digest

A version derived from code, for state that outlives the process that built
it. A cache stamped with `sourceDigest([set])` is refused by any process whose
code differs — no constant to remember to bump.

```ts
// a SMALL module holding the code the state depends on
export const myCode = defineSourceSet("what this code produces");
myCode.include(import.meta);

// where the state is written / read back (a desktop host)
const digest = await sourceDigest([myCode]);
```

- **`core`** — `defineSourceSet(description)`: `include(import.meta)` adds the
  calling module. It takes `import.meta` itself: a module can only hand over
  its own, so the module whose code counts has no wrong spelling. Plain data,
  portable (a compiler that also runs in a browser host declares one).
- **`server`** — `sourceDigest(sets)`: sha256 over the static runtime import
  closure of every included module, read with Bun's transpiler (type-only
  imports erased) and resolved by `shared/resolve.ts` — Bun's resolution for
  what this repo imports (`@plugins/*` from `tsconfig.base.json`, Bun 1.4.4's
  measured extension order, a package by its `node_modules` entry), answered
  with async listings so a backend's walk never waits on the disk, and refusing
  (failing closed) what it cannot answer exactly. `resolve.test.ts` holds it to
  `Bun.resolveSync`, import by import, over a backend's and central's closures. Repo files
  count by path relative to the closure's common ancestor plus bytes — so main
  and a worktree with the same code agree — packages by `name@version`,
  builtins by name, and a name only a page's import map answers
  (`@browser-host/…`, declared by `framework/import-map-names`; no package
  of that name installed) by name: the runtime loads nothing for it. A `core/`
  module may hold such a lazy `import()` that only the page calls (the website
  demo's generated scenario does), and the server reaches every `core/`. Desktop-only (exempt from `no-platform-api`, sanctioned).
- **Fails closed, loudly.** A digest is awaited, never read half-done. An
  unresolvable import throws, and so does an `import(x)` / `require(x)` whose
  path is not a literal (counted on the transpiled output, so prose naming
  `import()` does not count): the digest cannot follow it, so it cannot vouch
  for the code it loads. Every consumer turns a throw into "no match" — the
  handoff inherits nothing, L2 stays off, corpus-index's read fails — never
  into reuse. There is no escape for a computed-path load: code reached
  through one is not hashed, so it could not invalidate what it shapes. A
  module that must load by computed path does it outside every guarded
  closure. Code a guarded closure does run loads by a literal path — server-core's
  boot sequence warms each plugin's core barrel through the literal `core` loader
  codegen writes into every server/machine registry entry, and a serving
  backend's entry imports its composition's registries by literal path.
  `computedLoads(path, text)` is that reading on its own, and
  `closureRefusal(entries)` the whole walk's refusal (any unresolvable import
  too), for a guard that keeps a closure digestable
  (`boot:closure-digestable` holds the serving backend's and central's with
  both). A refusal in a serving process is not silent either: restart-skip
  answers `cannot-judge` and the deploy files a `restart-skip-cannot-judge`
  report.
- **Once per process, as early as boot.** The plugin's `onReadyBlocking`
  starts every defined set's digest without waiting. A digest reads the files
  when it runs; a file edited after its module was imported would be counted
  as code this process runs, so it is read as close to the import as possible,
  and never re-read.
- **`closureChangedSince` reads only what changed.** The restart-skip
  judgement walks a backend's whole entry closure on every deploy. Each file's
  scanned imports are remembered per process under its stat stamp
  (`ino:size:ctime`, recorded only when the stamp before and after the read
  agree), so a later walk still visits and stats every file and re-resolves
  every import (against directory listings read fresh for that walk — so a file
  added since, shadowing a resolution, is seen; `Bun.resolveSync` answers from
  an in-process directory cache, measured returning a file already deleted), but reads and scans only files whose stamp moved:
  O(closure) stats + O(directories) listings, O(changed files) reads. The walk goes a level at a
  time, 64 files at once with one yield per batch: one file at a time, a warm
  walk of a backend (5,371 files) spent 128 ms on stats that cost 14 ms
  batched and yielded 5,371 times, letting unrelated backend work land inside
  it (build pipeline step 13: 0.33 → 0.12 s). The stats are the floor; only a
  change signal removes them.
- **The facts outlive the process (`shared/facts-store.ts`).** Every file's
  facts (sha256 + imports) are recorded under its stamp in one SQLite
  database shared by every process on the host (`sourceFactsDir`, WAL), keyed
  by the scanner (this Bun's revision + `digest.ts`'s own bytes — a change to
  either re-reads everything once). A stamp is the kernel's, so facts any
  process read under the file's present stamp are the facts of its present
  bytes: a boot's digests and a deploy's adoption walk read only the files
  written since any process read them. Every boot used to re-read and re-scan
  its closure (~0.6 s CPU before ready); restart-skip's boot warm-up (another
  ~0.6 s CPU while tabs resubscribed) is gone — the build's own closure checks
  (`boot:closure-digestable`) record the new code's facts before the deploy
  asks. Rows unread for 14 days are dropped.
- **Keep the included module small.** The digest moves with everything the
  module loads: include the module holding the parse or the compiler, not the
  plugin's server entry, or every unrelated change rebuilds the state.

Users: `infra/corpus-index` (`corpusFormat`), `network/live/query-resource`'s
`liveReadCode` (the epoch handoff and every persisted `all` set), and every
L2-persisted value's own code (`network/live`'s `serveValue` `code:
import.meta`, carried by `Resource.Declare`) — the L2 stamps judged by
`network/live/live-state-snapshot`, and `infra/warmup`'s `derivedFrom` (a
backfill runs once per change of its derivation code: `page/links`,
`apps/pages/content-search`). `sourceDigest` reads a set structurally
(`description`, `urls()`), so a holder that cannot import this plugin
(server-core's Declare) can carry one.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Digest of the code a source set loads: sourceDigest(sets) — sha256 over the static runtime import closure of the modules each set includes (repo files by relative path and bytes, packages by name@version, builtins by name; type-only imports erased), computed once per process, every defined set started at a serving backend's boot. What persisted or inherited state stamps itself with, so a cache built by other code is refused without a version anyone bumps. Central's reach to the source-digest closure walk: closureChangedSince(entries, sinceMs) — whether nothing a closure loads (repo files, package resolution entries) changed since an instant, by inode change time — and sourceDigest(sets), the digest of the code a set loads. The same walk the server barrel serves (shared/), so central reads its code exactly as a backend does: restart-skip's judgement, and central's own code build (build/central-build-id).
- Cross-plugin:
  - Imported by:
    - `apps/pages/content-search`
    - `build/central-build-id`
    - `build/restart-skip`
    - `infra/corpus-index`
    - `infra/warmup`
    - `network/live`
    - `network/live/live-state-snapshot`
    - `network/live/query-resource`
    - `page/links`
    - `reports/engine`
    - `stats/commits`
    - `ui/icons/saved-sources`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `shared/digest.ts`, `shared/resolve.ts`, `shared/facts-store.ts` (sanctioned)
    - `imperative-create-table-allowlisted` — `shared/facts-store.ts` (sanctioned)
- Server:
  - Exports (values):
    - `closureChangedSince`
    - `closureRefusal`
    - `sourceDigest`
- Central:
  - Exports (values):
    - `closureChangedSince`
    - `sourceDigest`
- Core:
  - Exports (types):
    - `ClosureSince`
    - `SourceSet`
  - Exports (values):
    - `allSourceSets`
    - `defineSourceSet`
- Sub-plugins:
  - **`computed-loads`** — How source-digest reads one module's loads: computedLoads(path, text) — the import(…) / require(…) calls whose path is not a literal, counted on Bun's transpiled output — plus the transpiler per…

<!-- AUTOGENERATED:END -->
