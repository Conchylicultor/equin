# Inverted exemptions: `exempt/` manifests replace owner-side allowlists

## Context

Today a rule's owner keeps the list of who may violate it. Consumers therefore edit
the owner's code to exempt themselves. This is the reverse of the slot / contribution
model used everywhere else in the repo (see "Collection-consumer separation" in the
root CLAUDE.md).

Inventory as of 2026-10-07:

| Source | Lists | Entries | Foreign (other plugin) |
|---|---|---|---|
| `ignores:` in `plugins/**/lint/index.ts` | 52 barrels, 68 rule keys | 204 | 72% |
| `ALLOWED_*` / `EXEMPT*` / `startsWith` lists in `check/` | 18 lists | ~70 | ~49% |
| `*_PLUGIN_DIR` / `OWNER_DIRS` constants inside lint rule files | ~16 rules | ~23 | ~half |

Notes on the inventory:

- The lists are a mix of permanent sanctions and burndown debt. `network/live` alone
  has 56 "NEVER add" files, and the timer rule has one TEMPORARY shadow audit.
- They are also partly stale. The root `cli/` named in no-raw-websocket and
  no-raw-event-source no longer exists, and nothing detects an exemption that
  suppresses nothing.
- There is no generic primitive. The inverted precedents are domain-specific:
  `ExcludeFromChangeFeed`, `duressExempt`, `IMPERATIVE_PUBLIC_TABLES`, and line-level
  `eslint-disable-next-line … -- reason`.

Goal: one generic mechanism where the exempted plugin declares its own exemption,
with a reason, and the system can list it. The old forms are banned. Everything is
migrated in one go.

## Design

### 1. The manifest: `plugins/<p>/exempt/index.ts` (new leaf folder)

```ts
import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["server/internal/watchdog.ts"],
    kind: "sanctioned",
    reason: "The queue's alarm: a queued watchdog would sit in the backlog it reports.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["web/internal/use-pages.ts"],
    kind: "debt",
    task: "<task id>",
    reason: "Not yet migrated to useLive.",
  },
] satisfies Exemptions;
```

**Rule ids.** `rule` is typed as the generated union `ExemptableRuleId`. An unknown or
misspelled id is a tsc error.

- Lint rules use their ESLint id, `<ns>/<rule>`.
- Checks use ids they declare (see §3).
- The union is generated at build into `exempt/core/rule-ids.generated.ts`, and an
  `exempt:rule-ids-in-sync` check catches drift, the same pattern as
  `plugins-registry-in-sync`.

**`kind`** is a discriminated union:

- `sanctioned` requires `reason`.
- `debt` requires `reason` and `task`.

Debt can then be listed as a burndown and is never hidden among legitimate uses. This
follows the precedent in `infra/paths/core/internal/legacy-layout.ts`.

**`paths`** are relative to the declaring plugin. Each entry is either a file or a
directory. A directory covers its whole subtree, and `"."` is the whole plugin.

- No globs. Real usage needs exactly two granularities: file (~75%) and subtree
  (~15%, whole plugin or a runtime subfolder). The `**/*.{ts,tsx}` suffixes in
  today's lists are an artifact of ESLint's `files` syntax.
- A path may not escape the plugin directory with `..` or an absolute path. A plugin
  can only exempt its own files, and that constraint is what makes the inversion real.
- A subtree covers child plugins on disk, so an umbrella owns its descendants.

**Leaf folder registration:**

- Add `exempt` to `LEAF_FOLDERS` in `plugins/framework/plugins/plugin-id/core/plugin-id.ts`.
- Add its row `exempt: ["core"]` (type import only) to `folders` in
  `plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts`.
  tsc forces the row once the folder is in the vocabulary.
- Discovery uses the collected-dir pattern: `defineCollectedDir("exempt")` in the new
  plugin's `core/collected-dir.ts`, which codegen turns into `exempt.generated.ts`
  (`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`).
  *Superseded 2026-10-20:* the registry went stale on every deleted or moved
  manifest; manifests are now found in the repo file set on each load — see
  `2026-10-20-tooling-exempt-manifests-from-disk.md`.

### 2. The primitive plugin: `plugins/framework/plugins/tooling/plugins/exempt`

Its `core` provides:

- the `Exemption` / `Exemptions` types, `ExemptableRuleId` and `FileCategory`;
- `loadExemptions(root)`, which returns resolved entries
  `{ rule, plugin, absPrefix | file, kind, reason, task? }` and validates them with zod;
- a matcher `exemptionsFor(rule).match(repoPath) → Exemption | undefined`, which
  records hits so unused entries can be reported.

`check/` provides `exempt:manifests-valid`. It fails on any of:

- a path that does not exist (stale);
- a path that escapes its plugin;
- a duplicate (same rule, same path) declared twice;
- an exemption of a rule declared `closed`.

`cli/` provides `./singularity exempt list [--rule <id>] [--plugin <path>] [--debt]`. It
prints rule → plugin → path → kind → reason/task, grouped by rule, with counts. This is
the "who may violate X" answer. The CLI declaration copies
`plugins/framework/plugins/cli/plugins/check/cli/{index,run}.ts`.

### 3. Rule owners: scope, not lists

Owners keep exactly two things, and neither names a consumer.

**Categories (`outOfScope`).** About 9% of today's entries are category patterns:
`**/*.test.ts`, `**/__tests__/**`, `**/e2e/**`, `scripts`, `bin`, `cli`, `central`,
`provision`, `research/`. These are rule scope, not exemptions.

- `FileCategory` is a closed union defined once in exempt core: `test`, `e2e`,
  `script`, `bin`, `cli`, `central`, `provision`, `research`.
- Its matchers reuse `NON_APP_FILE_GLOBS` (`lint/core/non-app-globs.ts`) and
  `isTestCodePath`.
- Lint barrels declare `outOfScope: { "<rule>": FileCategory[] }`.
- Checks declare `outOfScope` on the `Check` object.
- The 7 hard-coded `startsWith("research/")` skips become `research` in that
  vocabulary.
- `enforceEverywhere` stays: it is the inverse switch on the same axis.

**Closed rules.** Today 19 rule keys carry `ignores: []`, meaning "no exemptions".
These become `closed: ["<rule>"]` in the lint barrel, or `closed: true` on a check.
The validator rejects any manifest exempting a closed rule.

**Checks declare their exemptable ids.** A check that accepts exemptions declares
`exemptable: { "<id>": "<what violating it means>" }`.

- Ids are namespaced `<check-id>` or `<check-id>:<sub>`. For example, the paths check
  has separate lists for homedir/`~/.singularity`, data-root and
  worktree-artifacts, so it gets three ids.
- Only declared ids enter `ExemptableRuleId`.
- At runtime a check calls `ctx.exempt("<id>")` to get the matcher.

### 4. Enforcement paths

**Lint, type-check worker** (`checks/plugins/type-check/shared/worker.ts`):

- Exemptions are no longer config-level `"off"`. The rule runs everywhere.
- The worker drops messages whose `(file, ruleId)` matches an exemption and records
  the hit.
- After linting a file, any FILE-level exemption on it with no hit becomes an
  `(unused-exemption)` error. This is the same severity contract as
  `reportUnusedDisableDirectives: "error"`.
- Subtree exemptions get the stale check only, because the type-check is incremental
  and cannot see the whole subtree.

**Lint, IDE path** (`eslint.config.ts`). `buildLintConfig({ exemptions: "config-off" })`
emits per-file `"off"` blocks generated from the same manifests, replacing
`exemptConfigs` at `build-lint-config.ts:449-462`. Editors then show no squiggles on
exempt files. Both modes are built from one loader, so they cannot drift.

**Checks** (runner in `checks/core/runner.ts`):

- `ctx.exempt(id)` reads the manifests through the recording view, using `ctx.repo()`
  or `currentScanView()`, never a bare `import()`. A manifest edit then invalidates
  an `inputKeyed` PASS.
- After `run()`, the runner fails the check if any of its exemptions recorded no hit.
- The ~18 checks replace their constants with `ctx.exempt(...)`. Examples are
  no-raw-websocket, no-raw-sse, no-raw-event-source, `infra/paths`, `infra/namespace`,
  `infra/jobs`, `endpoints/no-raw-json-handlers`, `resource-runtime`,
  `durable-signals-accounted`, `type-scale`, `host-pools-declared` and `change-feed`.

**Lint rule files with embedded owner dirs.** Constants such as `SPAWN_PLUGIN_DIR`,
`FILE_WATCHER_DIR` and `OWNER_DIRS` that exist only to skip reporting are deleted. The
primitive plugin declares the exemption instead. Constants used for rule semantics
beyond skipping stay, decided per rule during migration.

### 5. Removing the dual-load constraint (prerequisite)

`build-lint-config.ts` cannot import `@plugins/*` today, because ESLint loads
`eslint.config.ts` through jiti, which has no alias. That rules out a clean import of
the exempt core.

Fix at the root:

- `eslint.config.ts` creates its own `createJiti(import.meta.url, { alias: { "@plugins": "<root>/plugins" } })`
  (jiti is already a root dependency) and imports the builder through it.
- Lint core may then use normal `@plugins` imports.
- The "relative because jiti" comments and workarounds go away: `lint/core/collected-dir.ts`
  inlining and the absolute-path barrel import.

### 6. Banning the old forms

- **`ignores` removed** from `RawContribution` in `build-lint-config.ts`. A barrel
  still carrying it throws in `loadContributions`, with a message pointing at
  `exempt/`. Lint barrels gain `satisfies LintContribution` so tsc rejects the key
  first.
- **New lint rule `exempt/no-path-allowlist`**, scoped to `check/` and `lint/` files.
  It flags array or Set literals of repo-path strings (`"plugins/…"`, `"cli/…"`) and
  `.startsWith("plugins/…")` path tests. It reports with "declare an exemption in the
  exempted plugin's `exempt/`".
- **Rule messages** that today say "add the file to `<owner>`'s ignores" are reworded
  to "add `plugins/<you>/exempt/index.ts`" (e.g. `no-unlisted-timer.ts`,
  `no-raw-set-interval.ts`).

### 7. Discoverability for agents

- **CLI:** `./singularity exempt list` (§2).
- **Docs facet** `plugins/plugin-meta/plugins/facets/plugins/exemptions/facet/`. It
  copies the `cross-refs` facet pattern: `extract` reads the manifest, and `relate`
  builds the reverse index.
  - On the exempting plugin: *Exempts itself from:* rule → paths → kind.
  - On the rule owner: *Exempted by:* plugin list, with debt counts.
  - The compact index gets an `[exempt]` marker beside `[test helpers]`, wired through
    `docgen.ts` lines 120-153.
  - `plugins-doc-in-sync` keeps all of it current.
- **CLAUDE.md:** a short "Exemptions" paragraph in the root CLAUDE.md under the
  plugin boundary rules, plus the exempt plugin's own CLAUDE.md.

### Out of scope (not "who may violate rule X")

- `boundary-config.ts` `exclude`. This defines composition roots as a role, consumed by
  two rules. It is better modeled as a declared role later.
- Identifier-keyed lists: `IMPERATIVE_PUBLIC_TABLES` (already consumer-declared),
  `PINNED_LEGACY_DESCRIPTORS`.
- `lint-scope-exceptions.ts`, guards `main-edits.ts`, the web-artifacts npm allowlist,
  and `eslint-disable-next-line` (it stays the line-level form).

## Migration (one go)

1. **Scripted extraction.** A script under `plugins/framework/plugins/tooling/plugins/exempt/scripts/`
   parses every lint barrel's `ignores` with the TS AST, keeping leading comments. It
   maps each path to its owning plugin (nearest dir with a plugin runtime folder) and
   classifies it:
   - category pattern → `outOfScope`;
   - empty array → `closed`;
   - file or subtree → a manifest entry, with the comment as `reason`;
   - comment containing BURNDOWN/TEMPORARY → `debt`.

   It writes or merges `exempt/index.ts` per plugin and deletes the `ignores` keys.
2. **Check lists and embedded rule dirs.** About 18 check files and about 16 lint
   rule files, each with its own idiom. Two or three subagents (Sonnet) work
   partitioned file sets, following the §3/§4 contract. Each subagent declares
   `exemptable` ids, replaces constants with `ctx.exempt`, and moves entries into
   manifests.
3. **Debt tasks.** Use `add_task` to file one task for the `network/live` legacy-spelling
   burndown (56 files) and one for the timer shadow audit, then reference them from
   the `debt` entries. The `network/live/lint/index.test.ts` "each listed file still
   imports an old spelling" test is deleted, because unused-exemption detection
   replaces it generically.
4. **Prune.** Run `./singularity check`. The stale and unused errors find dead entries,
   such as root `cli/` and any `web/__tests__/**` entry for a rule already off in
   tests. Delete them, and record what was pruned in the push message.

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`: loader,
  `RawContribution`, `exemptConfigs`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/worker.ts`:
  post-filter and unused detection.
- `plugins/framework/plugins/tooling/plugins/checks/core/{runner.ts,types.ts}`:
  `ctx.exempt`, `exemptable`, `closed`, `outOfScope`, the unused check.
- `eslint.config.ts`: jiti alias.
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` and
  `.../boundaries/core/boundary-config.ts`: the leaf folder.
- `.../codegen/core/{plugin-registry-gen.ts,docgen.ts}`: registry, rule-id union,
  `[exempt]` marker.
- New: `plugins/framework/plugins/tooling/plugins/exempt/{core,check,cli,lint,scripts}`,
  `plugins/plugin-meta/plugins/facets/plugins/exemptions/facet/`.
- Representative migrations: `plugins/network/plugins/live/lint/index.ts`,
  `plugins/infra/plugins/background/plugins/timer/lint/index.ts`,
  `plugins/infra/plugins/paths/check/index.ts`,
  `.../checks/plugins/no-raw-websocket/check/index.ts`.

## Verification

- `./singularity test plugins/framework/plugins/tooling/plugins/exempt`. Unit tests
  cover:
  - path resolution, including rejection of an escaping path;
  - the matcher, for file and subtree entries;
  - zod validation of `sanctioned` vs `debt`;
  - the extraction script, against fixture barrels.
- Mutation probes, each of which must fail `./singularity check` with a clear message:
  1. Remove a manifest entry. The rule fires on that file.
  2. Add an entry on a clean file. The run reports `unused-exemption`.
  3. Use a nonexistent path. The run reports stale.
  4. Exempt a `closed` rule. Rejected.
  5. Misspell a rule id. tsc error.
  6. Re-add `ignores:` to a lint barrel. Load error.
  7. Add an `ALLOWED_PATHS = ["plugins/…"]` to a check. `no-path-allowlist` fires.
- `bunx eslint` on an exempt file shows no squiggle (IDE path), and the same file
  fails if its manifest entry is removed.
- `inputKeyed`: editing only an `exempt/index.ts` invalidates the cached PASS of a
  check that consults it. Verify with the check cache via `--list` timings or the
  runner's cache log.
- Count parity: `./singularity exempt list` total equals the migrated entries minus
  those pruned in step 4. Each pruned entry is listed in the push message.
- `./singularity build`. `plugins-doc-in-sync`, `plugins-registry-in-sync` and
  `exempt:rule-ids-in-sync` pass. `docs/plugins-details.md` shows the
  *Exempted by* / *Exempts itself from* entries.
