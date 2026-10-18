# bundles

The **single authority on on-disk release bundles**: where a run dir lives,
which run a `latest-<platform>` pointer names, whether a bundle is shippable to
a given `(composition, platform)` — and if not, *why not*, in the exact words
the user sees.

## Why it is a plugin and not a file in `release/server`

The same question — "which bundle would `ship` pick, and why not?" — is asked
from two processes that share no runtime:

- `./singularity deploy ship` (a CLI process, no backend, no DB), and
- an HTTP handler in the Deploy app, which cannot `process.exit(1)`.

Before this plugin the answer lived inline in
`cli/plugins/deploy/cli/ship.ts` as a `resolveBundle` that called `refuse()` and
exited. That shape is unusable from a handler, so a UI would have had to
re-derive shippability — a second implementation, guaranteed to disagree.
`resolveBundle` now returns a discriminated `BundleResolution`; the CLI does
`if (!r.ok) refuse(bundleRefusalMessage(r.refusal))` and a handler renders the
same sentence.

## `server/` is DB-free, and that is a hard constraint

`@plugins/release/server` cannot be imported by a CLI process: its barrel
eagerly pulls `@plugins/database/server`, whose worktree pool is scoped to a
runtime namespace a CLI process does not have. That is why
`cli/plugins/release/cli/run.ts` used
to carry a hand-copied `releaseOutDir` / `newReleaseRunId` under a "KEEP IN
SYNC" comment.

This plugin exists on the other side of that line: **`server/` here reaches
`node:fs`, `node:path`, `@plugins/infra/plugins/paths/server` and
`@plugins/infra/plugins/spawn/core` — and nothing else.** No `db`, no `jobs`, no
`config_v2`, no plugin barrel that transitively pulls one. The duplication in
`release.ts` is gone because the canonical helpers moved *here* and both sides
import them.

If you add an import to `server/`, check its transitive closure. A DB import
would not fail a check — it would make `./singularity release` and
`./singularity deploy ship` crash at startup with a module-eval throw.

`core/` is browser-safe (zod + plain types only), so a web pane can render a
refusal and reason about staleness without a server round-trip for the strings.

## `bundleSignature`: when could the verdict have moved?

`bundleSignature({ namespace, composition, platform })` sits beside
`resolveBundle` and stats the same paths, in the same order: whether the
composition dir exists, where `latest-<platform>` resolves (or that it does
not), the run's `RELEASE.json` mtime and size, and whether
`dist/<comp>-web-<platform>` exists. Equal signatures ⇒ `resolveBundle` would
return the same verdict, so the release engine's `release.candidate` memo runs
the real resolution only when it moved. The packed binary is in it on purpose:
its appearance is the step that turns `not-packed` into shippable.

## The `latest-<platform>` pointer

A composition's run dirs sit under
`<SINGULARITY_DIR>/releases/<namespace>/<comp>-<target>/<run-id>/`, beside one
symlink **per platform**: `latest-linux-x64`, `latest-darwin-arm64`, …

Two properties are structural, not conventional:

- **Platform is in the name.** The old bare `latest` was keyed by
  `<comp>-<target>` only, so a host `--dev` run and a `linux-x64` candidate of
  the same composition overwrote each other and `ship` then refused on platform
  mismatch. Cross-platform clobbering is now impossible rather than diagnosed.
- **Only a packed run claims a pointer.** `claimLatestPointer` is called after
  `packStagedTree`, never from the `--dev` staging path. So "a pointer names a
  shippable bundle" holds by construction. (Consequence: a hand-run
  `release --dev` followed by a bare `ship` now refuses *"no `latest-<platform>`
  pointer"* rather than *"staged but never packed"* — a better message, but a
  different one.)

`latestPointerName()` and `claimLatestPointer()` are the only two spellings of
the name; the reader and the writer change together.

## Provenance and `Staleness`

`readGitProvenance()` is read **before** the artifact phase — the hermetic
`build` it shells into writes generated files into the checkout, so a dirty read
taken after it would
report every release as dirty and say nothing about what the human left in the
tree. `commitDirty` uses `git status --porcelain --untracked-files=normal`:
untracked files count, because vite builds untracked files into the dist.

`compareToHead()` maps that provenance onto `Staleness`. The load-bearing member
is `unknown`: a dirty build is **always** `unknown`, never `current`, because the
sha names the parent commit and not the bytes. A sha this repository has never
seen is `unknown` too, not a throw — a run dir outlives the branch it was cut
from. In an active worktree most candidates read `unknown`; that is the honest
answer, and consumer copy must say so rather than soften it.

## Retention

`pruneReleaseRunDirs(compDir, keep = 3)` keeps the newest `keep` run dirs of one
`<comp>-<target>` dir plus every run some pointer names. `~/.singularity/state/releases/` had no
retention at all, and a run dir is a whole staged app — this is the only thing that
bounds it. A release's *logs* are bounded separately and far more cheaply, by the
shared per-kind supervised-run transcript prune.

**Known bound:** the pinned set is the pointer set only. A live Studio *preview*
running out of an older run dir is invisible from here — previews live in the
release engine's in-process map, and this module stays engine-free so a CLI
process can import it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The on-disk release-bundle registry: run-dir layout, the `latest-<platform>` pointer, resolveBundle()'s discriminated verdict, git provenance + staleness, and run-dir retention. Strictly DB-free so a CLI process can import it.
- Server:
  - Uses: `infra/paths.GIT`
  - Exports (types):
    - `GitProvenance`
    - `PruneResult`
  - Exports (values):
    - `bundleRoot`
    - `bundleSignature`
    - `claimLatestPointer`
    - `compareToHead`
    - `compositionReleaseDir`
    - `isPointerName`
    - `latestPointerName`
    - `latestPointerPath`
    - `newReleaseRunId`
    - `pruneReleaseRunDirs`
    - `readGitProvenance`
    - `readHeadSha`
    - `releaseOutDir`
    - `resolveBundle`
- Core:
  - Uses:
    - `ids.defineIdKind`
    - `ids.IdOf`
  - Exports (types):
    - `BundleRefusal`
    - `BundleResolution`
    - `ReleaseManifest`
    - `ReleaseRunId`
    - `Staleness`
  - Exports (values):
    - `bundleRefusalMessage`
    - `DIRTY_WORKTREE_REASON`
    - `namespaceHint`
    - `ReleaseManifestSchema`
    - `releaseRunIdKind`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deployments`
    - `release`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/claim-pointer.ts`, `server/internal/out-dir.ts`, `server/internal/pointer.ts`, `server/internal/prune.ts`, `server/internal/resolve-bundle.ts` (debt)

<!-- AUTOGENERATED:END -->
