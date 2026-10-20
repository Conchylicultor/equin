# Exemption manifests discovered from disk, not from a generated registry

## Context

`exempt/core/exempt.generated.ts` is a codegen'd list of every plugin's
`exempt/index.ts`, each with a static `import("@plugins/<p>/exempt")` loader.
`loadExemptions()` trusts that list. Delete or move a manifest and, until
`./singularity build` regenerates the list, every consumer throws
`Cannot find package …` — the ESLint config (IDE + type-check), the check
runner (`plugin-boundaries`, `boundaries:portable-closure`, every check that
calls `ctx.exempt`), `exempt:manifests-valid` and `./singularity exempt list`.
The message never says "the registry is stale". The reverse also holds: a new
manifest is ignored until a build, so its exemptions silently do not apply and
the violations it was written to cover fire anyway. Every agent in a
multi-agent session hit the first case.

The registry is a *derived copy of a filesystem fact* ("which `exempt/index.ts`
files exist"), and every consumer reads the copy instead of the fact. Unlike
runtime registries (web/server), nothing here needs a static import graph: all
consumers are Bun-side tooling that already holds (or can cheaply get) the
repo's file set. So the fix is rung 1 — delete the copy; there is nothing left
to go stale.

## Design

**Discovery from the repo file set.** `exempt/core` gets

```ts
/** The part of tooling/core's RepoFiles the loader needs (structural: tooling/core imports exempt/core types, so it cannot import back). */
export interface ManifestSource { root: string; glob(pattern: string): readonly string[]; read(path: string): Promise<string | null>; }

export function exemptManifestPaths(files: ManifestSource): string[]   // was exemptionInputPaths()
export async function loadExemptions(files: ManifestSource): Promise<ResolvedExemption[]>
```

- `exemptManifestPaths` = `files.glob("plugins/**/exempt/index.ts")`, filtered
  by the exact plugin-path shape `^plugins/(?:[^/]+/plugins/)*[^/]+/exempt/index\.ts$`
  (the glob is superset-safe, the filter is the definition).
- `loadExemptions` imports each by absolute path (`${root}/${path}`), keeping the
  current collect-every-failure error. No `node:*` import is needed in core.
- The registry, `exempt/core/collected-dir.ts`, `EXEMPT_REGISTRY_PATH` and the
  `exemptCollectedDir` export are deleted.

**`RepoFiles.glob(pattern)`** (tooling/core). Needed so an input-keyed check
records the manifest *set* as one `GlobFact` instead of the whole `plugins/**`
membership (which `under("plugins")` would record — invalidating the cached
PASS of every input-keyed check on any file add). Implementations:
- `repoFilesOver` (tooling/core): filter `paths` with `pathspecToRegex`.
- `recordingRepoFiles` (checks/core/repo-set.ts): `view.glob(pattern)` — records and
  replays exactly what `validate` compares.
- `pathspecToRegex` / `stripPathspecMagic` move from `checks/core/read-set.ts`
  into tooling/core (next to `pathsUnder`), so the base set and the snapshot
  answer a glob with the same regex. read-set imports it.
- Test fakes implementing `RepoFiles` (codegen tests) gain `glob`.

**Consumers** (each passes a `RepoFiles`):
- check runner (`checks/core/runner.ts`): `loadExemptions(<run's repo>)`, memoized as today.
- `checks/core/check-exemptions.ts` and `exempt/check`: read
  `exemptManifestPaths(recordingRepo)` through the check's own `ctx.repo()` —
  membership + content now both recorded (previously membership was recorded
  only via the registry file's bytes).
- `lint/core/build-lint-config.ts`: `loadExemptions(await loadRepoFiles(root))`.
- `type-check/check/prepare.ts`: same, with the listing's root.
- `exempt/cli/list.ts`: `loadRepoFiles(repo root)`.

**Codegen cleanup.** `exempt` was the only `membership: "checkout"` collected
dir. With it gone the option is dead; remove `CollectedDirMembership`, the
`membership` field, `membershipOf` / `MEMBERSHIP_ARG_RE`, the `checkout` branch
of `committedRegistryBundle` and their tests (`collected-dir/core/define.ts`,
`codegen/core/plugin-registry-gen.ts` + test). Every collected dir is then a
composition registry, as before exempt.

**Docs.** `exempt/CLAUDE.md` (the "collected by defineCollectedDir … checkout"
paragraph → "discovered from the repo file set on every load; no registry"),
note in `research/2026-10-07-global-inverted-exemptions.md` pointing here.

## Why not the cheaper fixes

- *`isPresent` skip-with-warning* (the CLI registry's approach): fixes deletion
  only; a new or moved manifest is still silently ignored until a build.
- *Better error message* (rung 4/5): still breaks every lint and check; it only
  tells you why.

## Verification

- `./singularity test plugins/framework/plugins/tooling/plugins/exempt plugins/framework/plugins/tooling/plugins/codegen plugins/framework/plugins/tooling/plugins/checks/core plugins/framework/plugins/tooling/core`
  plus a new loader test: a temp repo with two manifests, one deleted → loads
  the other; one added → loaded without any codegen.
- Manual repro: move an `exempt/index.ts` aside, run
  `./singularity check exempt:manifests-valid plugin-boundaries` and
  `./singularity exempt list` → no "Cannot find package"; restore.
- `./singularity build` (full checks) green.
