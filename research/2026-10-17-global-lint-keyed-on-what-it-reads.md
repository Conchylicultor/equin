# Lint keyed on what it reads (Rung 2, step 1)

Task: task-1792154726-esdnfe (att-1792238889-bnwy01). Track: "Track: build and push speed"
(wiki block-e5afc5b1-…), design: "Rung 2 design" sub-page (block-a9e68ab6-…), step 1.

## Context

Lint is now most of the type-check worker's cost. Of 158 worker runs after the 2026-10-15 lint
fix, the median run linted 985 files. Runs linting more than 1,000 files spent 80 % of the
6.9 CPU-h and peaked at 12–19 GB, against about 4 GB under 100 files (Phase 0 table on the design
page). The cause is the key. `check/fingerprint.ts` keys each file's lint result on the file plus
the SOURCE of its whole forward import closure, so a body-only edit in a hub re-lints every
transitive importer. tsc stopped paying for that once real signatures landed (2026-09-10). Lint
never did. Replayed over 30 days of main, today's key makes a median of 470 files stale per
commit (p90 6,218).

What lint actually reads:

- **Syntactic rules** (all but 11) read the file's own text. Their result is a function of
  (file text, rule source, engine).
- **Type-aware rules** (7 custom, 4 typescript-eslint, `promise-safety/no-floating-promises`)
  read the file's text and the checker's types for it. Those types are a function of the file
  plus the *declarations* of what it can see: the files it transitively references and the
  global-scope files. They never read another file's source.

So the fix is the key itself. It is not a cache in front of the cost: a file is re-linted when
something it reads changed, and only then.

## Design

### 1. Two kinds of rule, declared on the rule

The kind is `meta.docs.requiresTypeChecking`. That is the typescript-eslint convention, already
set on its rules and typed in `ESLintUtils.RuleCreator`. The 7 custom type-aware rules
(`no-class-as-grid-width`, `use-field-branded`, `hook-binding-name`, `no-endpoint-read`,
`no-unanchored-passthrough`, `no-detached-watch-reaction`, `no-async-raw-button`) and
`promise-safety/no-floating-promises` gain `requiresTypeChecking: true`.

There is one classifier, `isTypeAwareRule(rule)` in `lint/core/build-lint-config.ts`.
`LintRuleSelection` gains `kind: "syntactic" | "type-aware" | "all"`, so `buildLintConfig`
registers only the matching rules. The editor path (`eslint.config.ts`) is unchanged.

Enforcement, so a misclassified rule cannot cache a wrong result:

- **Loud at runtime (rung 4, by construction).** Syntactic rules run in a verify pass with no
  program: `ParserTypeSource` gains `{ none: true }`, which configures no
  `programs` or `project`. Every custom typed rule gets its services through
  `ESLintUtils.getParserServices(context)`. That call throws without type info, so an
  undeclared type-aware rule fails the check instead of storing an answer that depended on
  types.
- **Static (rung 3)** for a lazily-reached `getParserServices` (`no-endpoint-read` calls it on
  one path only): a lint rule `lint/type-aware-rule-declared`. A rule module that calls
  `getParserServices` / reads `parserServices` must declare `requiresTypeChecking: true`.

### 2. The keys

The result store moves to a new data dir (`type-check-lint-results-v2`), keyed per
**(file, own content hash)** instead of (file, closure fingerprint). Inside an entry, as today,
`known` holds result keys and `messages` holds the non-empty results:

| Part | Result key | Re-linted when |
| --- | --- | --- |
| each syntactic group (base + one per contribution, unchanged from `lint-groups.ts`) | group fp | the file's text, or that group's rules/engine change |
| ONE type-aware group `LINT_GROUP_TYPED` | hash(typed fp, **type fp** of the file) | the file's text, the declarations it can see, or any type-aware rule changes |
| directive file (`LINT_GROUP_ALL`, unchanged rationale) | hash(all fp, type fp) | any of the above |

- **typed fp** = hash of the base group fp plus the fps of the contributions that hold a
  type-aware rule. Prepare learns which contributions those are by loading them through the
  same classifier, so a syntactic-only rule edit does not stale the typed group. There is one
  typed group rather than one per contribution. A typed rule edit is rare (8 rules), its cost
  is resolving types for every file whichever typed rule changed, and the worker job stays
  small. Per-group typed keys are a refinement if typed-rule edits turn out to be frequent.
- **type fp(f)** is computed from the `.tsbuildinfo` tsc writes. That file is tsc's own record of
  what each file references (`referencedMap`, which already includes module augmentations and
  ambient modules) and of each file's public shape (`fileInfos[].signature`, the hash of its
  `.d.ts`). type fp(f) = Merkle hash over the strongly-connected-component condensation of
  `referencedMap`. Each component hashes its members' signatures (version when tsc stored a
  placeholder: a string entry or a missing signature, the conservative side) plus its
  successors' hashes. The **global fp** is folded into every type fp: the signatures of every
  `affectsGlobalScope` file (lib, `@types`, the 11 repo files with `declare global`). That
  matches tsc's own rule that a global file's change affects everyone. The whole computation is
  O(V+E) and replaces today's O(Σ closure) per-file closure walk.
  - A body edit leaves the file's signature unchanged, so no importer goes stale. An API change
    stales its transitive referencers, which is a superset of what tsc re-checks and so sound.
  - It lives in `shared/type-fingerprint.ts` (pure: buildinfo JSON in, `rel → type fp` out) and
    is added to the lint engine fp beside `shared/worker.ts`.

### 3. When is the type fp known? (the chicken and egg)

New signatures exist only after tsc runs inside the worker. So:

- **Signature table store** (new, `type-check-type-fps`, sibling of `programPassDir`): program
  key → `{ rel: type fp }` (about 200 KB per entry). `finalize` records it whenever a worker came
  back, under the post-run program key it already recomputes for the PASS. That is sound because
  the program key pins the program's full content, and signatures are a function of it. A tsc
  error does not stop the record: signatures are facts of the program, not of its verdict.
- **Prepare**: if the program key has a table, every file's typed key is known up front. Only
  stale parts go to the worker, and the program skip works as today: no syntactic or typed part
  stale and the program PASS recorded means no worker. Without a table (the program changed, or
  a cold run), the typed decision moves into the worker. Each lintable file's job carries its
  known typed keys (at most 3).
- **Worker** (`shared/worker.ts`): after the emit it computes type fps from the buildinfo text it
  just wrote, which the writer callback already holds. For each job it lints:
  1. the stale syntactic groups, in a verify with the `none` type source;
  2. the typed group (or the whole file, for a directive file) with the program, when its key is
     not in `known`.

  It returns the messages per part, plus the type-fp table for `finalize` to store under the
  keys and to record.
- Null-id messages (parse failures) belong to the syntactic base part. The typed pass drops
  them, since the same text already produced them in the syntactic pass.

### 4. Transcript

The existing `type-check: lint N/M files (…)` line moves to after the worker, where N is the files
actually linted. It is split as `syntactic N1, typed N2`, and it keeps the stale-group breakdown
and says whether the typed decision came from a table or from the worker. So the Phase 0 grep
keeps working, now with the split. The `cpu` / `maxRSS` worker line is unchanged.

### What it removes, as a side effect

`computeClosureFingerprints` no longer builds per-file closures. Only content hashes and
directives remain, so the prepare thread loses its O(Σ closure) walk. The import graph stays for
the engine and contribution closures in `lint-groups.ts`.

## Correctness (within today's single program)

- **The rule survey (2026-10-17).** It covered all 98 contributions (about 144 rules) and the
  helpers they import.
  - No rule reads the filesystem, git, `process.env` or another file at lint time.
  - The one out-of-file input is the declared `@utility` set read from app.css, used by
    `space-ramp/no-dead-spacing`. It is already in the engine as `lintDataKey`.
  - `e2e-harness/no-networkidle` reads `context.cwd` (the repo root, which is stable).
  - Path-scoped rules depend on the path, which is part of the store key.
  - The react-hooks compiler rules (7.1.1) read no types and no files.
  - Type-aware: the 7 custom rules (all through `ESLintUtils.getParserServices`, which throws
    without a program, and none of which declares it yet), the 4 configured typescript-eslint
    rules and `promise-safety/no-floating-promises` (all `requiresTypeChecking: true` upstream).
    `no-unnecessary-condition` also depends on compiler options, and the root tsconfigs are in
    the engine.
- A syntactic result keyed on (text, group) is exact by construction: the rule has no program to
  read from, and the survey found nothing else it reads.
- The type fp is a superset of tsc's own affected-file relation, so a typed result is re-run
  whenever tsc would re-check the file, and more often.
- Directive files stay one unit (an unused directive depends on every rule).
- Exemptions are still applied at read time (`lint-verdict.ts`, unchanged).
- Migration: a new store dir, so the first run per host is a full lint (about 877 CPU-s, like the
  2026-10-15 change). The old dir is declared retired, with `reclaim: safe`.
- Tests: `lint-cache.test.ts` and `prepare-thread.test.ts` updated, and a new
  `type-fingerprint.test.ts`. The new test checks that a body edit leaves dependents' type fps
  unchanged, that an API change and a global-file change move them, that cycles are handled, and
  that a placeholder signature falls back to version.

## Benchmark (exit criterion)

Before = this branch's merge-base code, after = this branch, same host, `./singularity check
type-check --jobs 1`, store warm on the base tree, reading `lint N/M` and worker `cpu` / `maxRSS`:

1. Body-only edit in a hub (a function body in `web-sdk#core`, about 1,078 direct importers).
2. Body-only edit in a mid-size file (`network/live#web`).
3. Exported-type change in a leaf, and in a hub.
4. One syntactic rule edit; one type-aware rule edit.
5. A replay of about 8 real main commits sampled across the M4 quantiles (p50 / p75 / p90 of
   files stale today): parent tree warm, then the commit, old code vs new.

The results go on the design page as a before/after table against Phase 0. The fleet-level
confirmation (the Phase 0 grep over a day of worker runs after the push) is the next task.

## Files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`: `isTypeAwareRule`,
  `kind` selection, `{ none: true }` type source, `typeAwareLintGroups()`.
- The 8 type-aware rule files: `requiresTypeChecking: true`.
- New lint rule `type-aware-rule-declared` (under `tooling/lint`, plugin to pick at
  implementation).
- `checks/plugins/type-check/check/{fingerprint,lint-groups,lint-results,prepare,index}.ts`,
  `shared/worker.ts`, new `shared/type-fingerprint.ts`, `core/worker-protocol.ts`,
  `data-dirs/index.ts`, `CLAUDE.md` (the lint-cache section).
