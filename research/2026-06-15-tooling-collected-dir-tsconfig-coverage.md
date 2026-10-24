# Collected-dir → tsconfig `include` coverage check

## Context

Declaring `defineCollectedDir("X")` auto-registers the new `X/` runtime folder
everywhere that derives from the single source of truth `discoverCollectedDirs()`:
codegen's `standardPluginDirs` (R11 unknown-dir rule), the plugin-boundaries
checker, `plugins-registry-in-sync`, and the structure facet. **One consumer does
not derive from that source: the tsconfig `include` globs.** They are
hand-maintained JSONC, so a new collected-dir folder's `include` glob
(`**/plugins/*/X`) must be added by hand. Until someone does, files in the new
folder type-check as orphaned — `type-check` fails with "N lintable file(s)
belong to no tsconfig program", and the generic hint doesn't connect the failure
to the collected-dir declaration that caused it.

This was hit when adding the `composition/` collected-dir (the
`**/plugins/*/composition` glob had to be manually added to
`server-core/tsconfig.json`, alongside `check` and `facet`).

**Goal:** make this drift impossible to land silently, with a precise message
pointing at the exact missing glob — without introducing fragile machinery.

## Decision: a loud coverage check (not codegen auto-wiring)

The root cause is a *derived value not validated against its source*. The fix is
a check that re-derives the expected folder set from `discoverCollectedDirs()`
and asserts each is covered by some tsconfig `include`.

**Why not codegen the includes?** tsconfig files are hand-maintained JSONC that
mix manual entries (`bin`, `core`, `scripts`, `exclude`) with collected-dir
globs, and the *correct* target program differs per dir (node vs DOM libs —
`check`/`facet`/`composition` → `server-core`; a browser collected-dir → `web-core`).
Having codegen own a slice of a hand-edited JSONC array while inferring each
dir's runtime is exactly the fragile coupling the project's coding principles
warn against.

**Why a check is clean here:**
- It mirrors two existing precedents almost exactly:
  `checks/plugins/plugins-registry-in-sync/check/index.ts` (already iterates
  `discoverCollectedDirs`) and
  `checks/plugins/tsconfig-alias-single-owner/check/index.ts` (already validates
  tsconfig structure via `ts.readConfigFile`).
- Its expected set is *derived from the single source of truth*, so it can never
  drift from the codegen dir set.
- It need not know each dir's target runtime: it only asserts that **some**
  tsconfig covers the folder. `type-check` remains the backstop for
  *wrong-program* placement (DOM code in a node tsconfig fails to compile). The
  two checks compose: this one guarantees coverage exists; `type-check`
  guarantees it's the right program.
- It is declaration-driven, not file-existence-driven, so it catches the latent
  trap the moment `defineCollectedDir("X")` is added — before any plugin
  populates `X/` and before `type-check` would notice.

## Implementation

New check as a sub-plugin of `checks`, auto-discovered via the `check/`
collected-dir (no manual registry edit — `./equin build` regenerates
`check.generated.ts`). Mirror the `tsconfig-alias-single-owner` layout exactly.

### Files to create

```
plugins/framework/plugins/tooling/plugins/checks/plugins/collected-dir-tsconfig-coverage/
├── package.json     # mirror tsconfig-alias-single-owner/package.json
├── CLAUDE.md         # required by plugins-have-claudemd; explain the invariant
└── check/index.ts    # default-export Check
```

`package.json`:
```json
{
  "name": "@singularity/plugin-framework-tooling-checks-collected-dir-tsconfig-coverage",
  "version": "0.0.1",
  "private": true
}
```

### `check/index.ts` logic

Reuse helpers/patterns already in the two precedent checks:

1. `getRoot()` — `git rev-parse --show-toplevel` (copy from precedent).
2. `dirs = new Set(discoverCollectedDirs(root).map(d => d.dir))` — imported from
   `@plugins/framework/plugins/tooling/plugins/codegen/core` (same import
   `plugins-registry-in-sync` uses). Keep the `DiscoveredCollectedDir` around so
   the failure message can cite each dir's declaring `ownerDir`.
3. `listTsconfigs(root)` — `git ls-files *tsconfig*.json`, filter out
   `sidequests/` (copy from `tsconfig-alias-single-owner`).
4. For each tsconfig, read its **literal** `include` via
   `ts.readConfigFile(path, ts.sys.readFile)` (parses JSONC, does NOT resolve
   `extends` — exactly the local declaration). Collect every `include` string
   across all tsconfigs into one list.
5. A dir `X` is **covered** if any `include` string matches
   `new RegExp(`(^|/)${escapeRegExp(X)}(/|$)`)`. This recognizes every glob shape
   in use today:
   - folder globs — `../../../../**/plugins/*/composition` → matches `/composition$`
   - bare folder — `web` (web-core/tsconfig.app.json) → matches `^web$`
   - file globs — `plugins/**/lint/*.ts`, `plugins/**/vite/*.ts` → match `/lint/`, `/vite/`
   The `(/|$)` boundary prevents false positives (`check` does NOT match
   `.../checks/...`).
6. Collect uncovered dirs; if any, fail. Message lists each uncovered dir, the
   `core/` file that declared it (`ownerDir`), and the suggested glob
   `**/plugins/*/X`. Hint names the convention:

   > Add `**/plugins/*/X` to the `include` of the tsconfig for the runtime where
   > `X/` code executes — `plugins/framework/plugins/server-core/tsconfig.json`
   > for node/build-time code (alongside `check`/`facet`/`composition`),
   > `plugins/framework/plugins/web-core/tsconfig.app.json` for browser code,
   > `plugins/framework/plugins/central-core/tsconfig.json` for central code.

All 8 current collected dirs (`web`, `server`, `central`, `check`, `facet`,
`composition`, `lint`, `vite`) are covered today, so the check passes on a clean
tree.

### Critical files (read before editing)

- `plugins/framework/plugins/tooling/plugins/checks/plugins/tsconfig-alias-single-owner/check/index.ts` — copy `getRoot`, `listTsconfigs`, `ts.readConfigFile` usage, the `Check`/`CheckResult` local types, and the file layout.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts` — copy the `discoverCollectedDirs` import + iteration shape.
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts:68` — `discoverCollectedDirs` / `DiscoveredCollectedDir` source (no change).
- tsconfigs that already carry collected-dir globs (no change, used as reference):
  `server-core/tsconfig.json` (`check`/`facet`/`composition`),
  `web-core/tsconfig.app.json` (`web`), `central-core/tsconfig.json` (`central`),
  `tsconfig.tools.json` (`lint`/`vite`).

## Out of scope / explicitly NOT doing

- No change to `defineCollectedDir`'s signature (no runtime/program field). The
  check doesn't need it, and `type-check` already backstops wrong placement.
- No codegen of tsconfig `include` arrays.
- No change to `type-check`'s existing coverage gate; the two are complementary.

## Verification

1. `./equin build` — regenerates `check.generated.ts` (picks up the new
   sub-plugin) and the plugin docs. Then `./equin check` must pass
   (including the new `plugins-doc-in-sync` / `plugins-have-claudemd` /
   `plugins-registry-in-sync` checks for the new plugin).
2. `./equin check collected-dir-tsconfig-coverage` — passes on the clean
   tree (all 8 dirs covered).
3. **Prove it catches the bug:** temporarily delete the
   `"../../../../**/plugins/*/composition"` line from
   `plugins/framework/plugins/server-core/tsconfig.json`, re-run
   `./equin check collected-dir-tsconfig-coverage`, and confirm it fails
   naming `composition` + its declaring file + the suggested glob. Restore the
   line.
