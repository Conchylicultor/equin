# File records: which identities move, and whether they need to

Task: file records (file facts + the `*.scan.ts` scans) minted ~1.25M new keys
a day in the shared plugin-records store for ~40–54k distinct values
(`2026-11-12-global-plugin-records-store-layout.md` § What is left). A file
record is keyed by `recordKey(scanIdentity, ...params, rel, blob)`, the scan
identity by `recordKey("scan", module, merkleKeyOf(module), environment,
npmResolutions)`. Find which parts move far more often than the values, and
make the key depend only on what the value reads.

## Split: what one refill of the file records is

`records.v4.sqlite` started fresh at 16:54 on 2026-11-12. At 18:20 it held
114,792 file keys for 39,689 values. Recomputing every scan identity of every
main commit since 11-11 and the key of every file under it
(`$EQUIN_SCRATCH/attr.ts`, read-only on the store): **97.3% are exactly one
identity per scan** — one full refill of the current main state:

| scan identity | keys per refill |
| --- | ---: |
| `plugin-refs/refs.scan.ts`, params `dot`+`path` | 17,140 |
| `plugin-refs/refs.scan.ts`, params `dot` | 14,304 |
| `codegen/icon-manifest.scan.ts` | 13,211 |
| `icons/check/icon-uses.scan.ts` | 12,884 |
| file facts (`scan-imports.ts`) | 10,773 |
| `codegen/plugin-registry.scan.ts`, `import-specifiers` | 9,185 |
| `codegen/browser-host-coverage.scan.ts` | 9,178 |
| `codegen/eager-tier.scan.ts` | 8,425 |
| `codegen/data-views.scan.ts` | 5,094 |
| `boundaries/portability-facts.scan.ts` | 4,898 |
| `plugin-refs/refs.scan.ts`, params `relative` | 4,550 |
| `codegen/plugin-registry.scan.ts`, `default-export` | 2,087 |
| **total** | **111,729** |

So every move of one identity costs that row, and 1.25M a day is ~11 full
refills' worth. What moves an identity: its module's closure (any edit to
any module it imports), its params, the bun version, the lockfile's npm
resolutions.

## What moves, and how often

**Params.** plugin-refs' scan took the kind set as a param, and its three
callers ask for three sets (`relative-links-resolve`: `relative`;
`compositions-source-covers-origin`: `dot`; `plugin-refs-resolve` and the
mover: `path`+`dot`). Each set kept its own record of every file — 36k keys
for one scan, **a third of every refill**, all re-keyed together. A file's
refs of kind K are the same whichever kinds are read with them: the
parameter selected part of an answer.

**Closures.** Re-keying main commits out of the last 200 (2026-11-10 22:05 →
11-12 18:59, 1.9 days), `scripts/key-closures.ts`:

| scan | closure | re-keyed by | what moved it |
| --- | ---: | ---: | --- |
| icon-manifest | 19 | 10 | the icons core barrel: `lucide-map.ts` alone 11 commits since 11-05 |
| icon-uses | 15 | 7 | the same barrel |
| refs, plugin-registry, data-views, eager-tier, browser-host-coverage, portability-facts | 21–29 | 4 each | `parse-utils/core` → `timed-fs` (8 commits since 11-05), `plugin-id` (2), `product-name` (1), `user-path` |

None of those moving modules is code the scan runs:

- the icon scans call `iconUsesIn` / `isIconRefModule` — two import-free
  modules — but import them through the icons core barrel, whose 15 modules
  hold the Lucide map, glyph tables and style keys every icon addition edits;
- the six parse-utils scans call its pure parsers (`maskSource`,
  `findImports`, `matchBracket`, `markerCallSpans`, …), but `helpers.ts`
  also held the file-system walkers (`walkFilesSync`, `sourceFilesIn`,
  `readIfExistsSync`, `pathExistsSync`), and with them `timed-fs`,
  `user-path`, `plugin-id` and `product-name` (11 modules) entered every
  scan's key.

Weighted by keys per refill, main's own closure moves cost ~522k keys per 200
commits (**~280k a day**).

**npm.** `npmResolutionsKey` moved 6 times in 7 days (11-05 → 11-12; twice on
11-11), each a full refill (~112k). File facts' `scan-imports.ts` imports
nothing at all, and four of the eight scans import no package; only
icon-uses (`@typescript-eslint/parser`), refs (`jsonc-parser`, via config
refs) and the two scans handed the `typescript` module by their caller read
npm code. **~110k a day.**

**Measured on the day itself.** The same attribution over v2's 1,249,045 file
keys last read on 2026-11-11 (`used` = 20768), against every main commit from
11-08 to 11-12 06:00 (identities recomputed at each commit touching a closure
module or `bun.lock`, each file's key at every blob it had):

| identity | identities seen | keys |
| --- | ---: | ---: |
| icon-manifest | 10 | 108,251 |
| refs `dot`+`path` / `dot` / `relative` | 5 each | 69,713 / 57,960 / 18,612 |
| plugin-registry `import-specifiers` / `default-export` | 5 each | 36,847 / 8,320 |
| browser-host-coverage | 5 | 36,813 |
| eager-tier | 5 | 34,390 |
| data-views | 5 | 20,825 |
| portability-facts | 5 | 19,305 |
| file facts | 3 | 17,927 |
| **main's identities** | | **428,963 (34%)** |

So the estimates hold for main (~390k estimated, 429k measured), and refs'
three kind sets are a third of it (146k).

**Worktrees: the other 66% (820k)** are identities no main commit has: an
agent editing a module inside a scan's closure (an icon added to
`lucide-map.ts`, a `timed-fs` change) mints a refill of that scan for every
state it builds (and older main identities, before 11-08, a worktree based
there still reads). The closure narrowing below removes these for every
module that left the closures — an edit to `timed-fs` or the icons barrel in
a worktree now re-keys no file record at all.

## Fix

- **One plugin-refs scan for every kind** (`refs.scan.ts`): no params; the
  caller filters (`findPluginRefs`). 36k → ~21.7k keys per refill, and one
  record per file whatever a pass asks for. `FileScan.params`' doc now says
  never to take a parameter that selects part of an answer.
- **`ui/icons/plugins/icon-uses`**: `iconUsesIn` and `isIconRefModule` moved
  out of the icons core barrel into an import-free leaf (the pattern of
  `boundaries/runtime-exception`). icon-uses' closure 15 → 4 modules,
  icon-manifest's 19 → 8.
- **`plugin-meta/parse-utils/plugins/source-files`**: the file-system walkers
  moved out of `parse-utils`; `parse-utils/core` imports nothing outside
  itself. The six scans' closures 21–29 → 10–24 modules; none reaches
  `timed-fs`, `user-path` or `product-name`.

| scan | closure before → after | re-keyed (of 200) before → after |
| --- | --- | --- |
| refs | 29 → 24 | 4 → 3 (×3 key sets → 1) |
| plugin-registry | 21 → 10 | 4 → 1 |
| data-views | 21 → 10 | 4 → 1 |
| eager-tier | 26 → 15 | 4 → 1 |
| browser-host-coverage | 26 → 15 | 4 → 1 |
| portability-facts | 22 → 11 | 4 → 1 |
| icon-manifest | 19 → 8 | 10 → 3 |
| icon-uses | 15 → 4 | 7 → 1 |

(An "after" re-key is the commit that created or edited the scan itself.)

Per edit — file keys one edit to a module re-keys (keys per refill of every
scan whose closure holds it; refs after = its old `dot`+`path` and
`relative` sets, ~21.7k):

| an edit to | before | after |
| --- | ---: | ---: |
| `packages/timed-fs`, `infra/host-fs/user-path` | 74,867 | 0 |
| `framework/plugin-id`, `framework/product-name` | 74,867 | 21,690 (refs alone) |
| `plugin-meta/parse-utils/core` | 74,867 | 60,557 |
| `plugin-refs/core`, `entry-pattern`, `runtime-exception` | 36,000 | 21,690 |
| `ui/icons/core` (`lucide-map.ts`, glyph tables, style keys) | 26,095 | 0 |
Weighted the same way: ~522k → ~156k keys per 200 main commits, **~280k →
~85k a day** from main's closure moves, and a refill ~112k → ~97k.

**Never stale**: nothing was taken out of a key — each scan's key is still
its module's whole static+dynamic closure; the closures are smaller because
the scans no longer import code they do not run. `file-scans.test.ts` pins
it: an edit to a module the scan runs rescans every file, an edit beside the
closure rescans nothing, one file's edit rescans that file, each param list
keeps its own records. `plugin-refs.test.ts`: every kind set reads through
the one scan, and each answer is the all-kinds answer filtered.

## What is left

- **npm** (~110k a day, now the largest main-side part): key each producer by
  the npm closure it names (`lockfileNpmClosure` over the packages its
  closure imports, type-only imports included — the `typescript` module
  handed to icon-manifest and portability-facts is visible only as `import
  type TS from "typescript"`), not the whole lockfile. Filed as a follow-up;
  it needs `deps/npm`'s closure walk without widening plugin-records/core,
  which the evaluator and facet harness key on.
- **Two scans in one module** (plugin-registry's `default-export` /
  `import-specifiers`): two answers, not a filter — 2k keys, left.
