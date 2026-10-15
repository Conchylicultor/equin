# Lint cache: stop one rule / exempt / lockfile edit from re-linting the whole repo

Track: "Track: build and push speed" (wiki block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851), item `[Lint]`.

## Context

The type-check worker lints only files whose import closure changed, except when a
"global trigger" changes (`isGlobalTrigger`, `type-check/check/fingerprint.ts`): then every
file's closure fingerprint flips and the worker lints all ~11.4k files with type-aware
rules: ~12–16 CPU-min and a 17–22 GB footprint, against ~40–55 CPU-s / 3–4 GB warm.

Measured on main, last 7 days (226 first-parent commits, 61 touch a trigger):

| trigger touched | commits | what actually changed |
| --- | --- | --- |
| `bun.lock` | 37 (25 alone) | **37 of 37 only add/remove a workspace entry** (a new plugin's `package.json`). With the `workspaces` section and the `@workspace:` package lines dropped, the lock's digest changed in **0** of them. |
| `plugins/**/exempt/**` | 24 (10 alone, +4 with lock only) | an exemption manifest: it only decides which messages are DROPPED |
| `plugins/**/lint/**` | 19 | almost always one contribution's rule (often only its `*.test.ts`) |
| tsconfig / `.d.ts` | 3 | genuinely global |

So the key is far too coarse. The fix is at the key, not at the cost (Performance
instructions: O(changes), no all-or-nothing invalidation).

## Design

Three stages, each a strict narrowing of the lint key. Stages 2–3 share one new store.

### Stage 1 — the lockfile counts by its npm resolutions

`bun.lock` enters the lint key through a digest of its content minus the top-level
`"workspaces": { … }` section, minus every `@workspace:` package line, minus blank lines
(the lockfile is bun's deterministic text format; an unrecognised shape falls back to the
whole-file hash — over-invalidation only). Also add `patches/**` to the triggers: a
`patchedDependencies` patch (eslint-plugin-react-hooks today) changes lint behaviour and is
not a trigger now (pre-existing gap).

Only the LINT key changes. The outer read-set and the tsc program key keep the whole
lockfile (a commit that adds a workspace adds `.ts` files anyway, so both miss regardless).

### Stage 2 — exemptions applied at read time

Today the cache stores only a PASS marker per (file, closure fp), recorded AFTER exemptions
were applied, so the key must include every exemption manifest. Instead:

- The worker returns each linted file's **raw** error-level messages (before exemptions):
  `{ ruleId, line, column, message, fatal }[]`.
- A new host-global **lint result store** (new data dir `type-check-lint-results`;
  `closureCacheDir` retired) holds, per `(file, closure fp)`, those raw messages.
- `finalize` (preparation thread) assembles messages for EVERY lintable file — cached and
  freshly linted — applies the current exemptions (`loadExemptions` + `createExemptionIndex`,
  filtered by `isLintRuleId`; rule-id validation stays with `exempt:manifests-valid`),
  computes the unused file-level exemptions (now for every file, not only re-linted ones), and
  returns the violation lines. The runner's verdict reads them from `finalize`, not from the
  worker. `exempt/**` leaves the lint key (still in the outer read-set: it IS a verdict input).

### Stage 3 — one key per lint contribution

Rule groups = `base` + one per lint contribution (`lintEntries[].pluginPath` from
`lint.generated.ts`).

- `fp(base)` = everything global that is not a contribution: `eslint.config.ts`, the lint
  tooling plugin's own `core/`, `lint.generated.ts`, `LINT_DATA_FILES`, tsconfigs, root
  `package.json`, the stage-1 lock digest, `patches/**`, `.d.ts`. Base rules
  (typescript-eslint, react-hooks, eslint core) belong to it, as do fatal parse messages.
- `fp(g)` = the forward import closure of `plugins/<g>/lint/index.ts` (the existing
  `graphs.forward`), stopping at base files. A rule's `*.test.ts` and `tsconfig.case.json`
  are no longer inputs; a helper the rule imports from outside `lint/` now IS one (today a
  silent gap).
- Store entry per `(file, closure fp)`: `{ groups: { [g]: [{ fp, messages }] } }`, the last
  3 fps per group kept so two worktrees on different versions of one rule do not thrash.
  Read-modify-write, atomic rename; a lost race is only a later miss.
- A file is stale for group g when no stored version matches `fp(g)`. The job sends each
  file with its stale groups; the worker builds one config per distinct group set
  (`buildLintConfig({ …, only: { base, contributions } })`: parser settings always,
  rules only of the selected groups) and splits messages back by ruleId namespace
  (contribution `name` → pluginPath; anything else and `null` → base).
- **Disable directives make a file one unit.** An unused `eslint-disable` report depends on
  every rule. A file whose text matches `eslint-(disable|enable)` (477 of 11.4k) is keyed as
  a single `all` group over `hash(all group fps)` and always re-linted in full; for every
  other file a disable-directive report cannot occur, so per-group results are exact.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/fingerprint.ts` — lock digest, split triggers into lint-key groups, group fps.
- `…/type-check/check/closure-cache.ts`, `check/pass-set.ts` — the result store (pass-set gains a JSON read; program passes unchanged).
- `…/type-check/check/prepare.ts` — stale-group plan, finalize records + read-time exemption pass.
- `…/type-check/shared/worker.ts`, `core/worker-protocol.ts` — per-file group sets in, raw per-group messages out.
- `…/type-check/check/index.ts` — verdict from finalize's lint lines.
- `…/type-check/data-dirs/index.ts` — new store, retire `closure`.
- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — `only` selection.
- `cli/plugins/build/cli/internal/app-artifacts.ts` (fast path, no lint files) — keep compiling against the new result shape.
- Docs: type-check `CLAUDE.md` (cache section, transcript lines).

## Verification

- Unit tests (`./singularity test …/type-check`): lock digest ignores workspace-only diffs
  (fixture from a real commit pair) and sees a version bump; stale-group computation; entry
  merge keeps ≤3 versions; read-time exemption + unused-exemption assembly.
- Benchmark on this worktree, `./singularity check type-check --jobs 1`, reading the
  transcript's worker line (cpu, maxRSS) and a new `type-check: lint N files (… stale groups)`
  line. Before (current code): warm no-op, and one contribution-rule edit (full re-lint).
  After: warm no-op; workspace-only `bun.lock` edit; exempt manifest edit; contribution
  rule edit; rule `*.test.ts`-only edit; a `lint/core` edit (still full, expected).
- Historical replay: the share of the last 7 days' main commits that still force a full
  re-lint (61 → expected ~3: the tsconfig / `.d.ts` / lint-core ones).
- `./singularity build` green (all checks).

## Out of scope (next task)

Incremental normalize inside the push lock; phys_footprint memory line; `--smol`.

## Results (implemented 2026-10-15)

Deviations from the plan above: `app.css` (a lint data file, 11 edits that week) now counts by its
declared `@utility` set (`lintDataKey`); the engine is the config builder's import closure (generated
registries not followed) plus `shared/worker.ts` alone; `eslint.config.ts` is not an input (the worker
never reads it); only the ROOT tsconfigs count (every other one is a rule test's fixture).

`./singularity check type-check --jobs 1`, worker `cpu` / `maxRSS`, this host:

| Change | Before | After |
| --- | --- | --- |
| Comment in one rule (icons) | 657 CPU-s, 21.4 GB | 240 CPU-s, 10.8 GB (icons group on 10,982 files, 481 directive files whole) |
| Exemption manifest edit | full re-lint | 24 CPU-s, 3.1 GB (1 file) |
| Rule test edit | full re-lint | 25 CPU-s, 3.1 GB (1 file) |
| New plugin (workspace-only lockfile) | full re-lint | 34 CPU-s, 3.3 GB (1 file) |
| Unchanged tree | — | 38 CPU-s, 3.2 GB (0 files) |
| Cold store, first run | — | 877 CPU-s, 18.8 GB (all files, once) |

Replay of main's 229 first-parent commits in the 7 days to 2026-10-15: a full re-lint on 72 with the
old key, 9 with the new one (5 `@utility` set, 2 root tsconfig/package.json, 1 `.d.ts`, 1 exempt
tooling core); 18 re-run one group.
