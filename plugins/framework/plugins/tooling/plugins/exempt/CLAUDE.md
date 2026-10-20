# exempt

Inverted exemptions: **the plugin that owns a file declares which rules that
file may violate**, in its own `exempt/index.ts` — never the rule's owner, in a
list of its consumers. The same direction as slots and contributions (root
`CLAUDE.md`, "Collection-consumer separation"). Plan:
`research/2026-10-07-global-inverted-exemptions.md`.

## Declaring an exemption

```ts
// plugins/debug/plugins/queue-health/exempt/index.ts
import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",          // ExemptableRuleId — a typo is a tsc error
    paths: ["server/internal/watchdog.ts"],    // relative to THIS plugin
    kind: "sanctioned",
    reason: "The queue's alarm: a queued watchdog would sit in the backlog it reports.",
  },
  {
    rule: "no-raw-websocket",
    paths: ["web/legacy-socket.ts"],
    kind: "debt",
    task: "task-…",                            // the task that removes it
    reason: "Not yet moved onto SharedWebSocket.",
  },
] satisfies Exemptions;
```

- `rule` — a contributed lint rule `<ns>/<rule>`, or an id a check declares
  `exemptable`. Typed as the generated `ExemptableRuleId`
  (`core/rule-ids.generated.ts`, written by `./singularity build`).
- `paths` — a file, or a directory (its whole subtree, child plugins included),
  or `"."` for the whole plugin. No globs, no `..`, nothing absolute, canonical
  spelling only: a plugin can only exempt its own files.
- `kind: "sanctioned"` — a permanent, legitimate use. `kind: "debt"` — a
  violation tracked for removal; it names its `task`.

The folder is a leaf (`LEAF_FOLDERS`, row `exempt: ["core"]`). There is **no
generated registry of manifests**: `loadExemptions(files)` finds every
`plugins/<p>/exempt/index.ts` in the repo file set it is handed (`RepoFiles`,
via `exemptManifestPaths` — one `glob` fact for an input-keyed check) and
imports each by path. So deleting, moving or adding a manifest takes effect on
the next lint or check, with no build in between — a registry used to break
every lint and check with `Cannot find package …` until `./singularity build`
regenerated it (`research/2026-10-20-tooling-exempt-manifests-from-disk.md`).
Every plugin on disk counts, including the ones the `singularity` composition
excludes, because lint rules and checks scan every plugin: the set a rule can be
exempted on must be the set it scans, or a violation in an excluded plugin
(`review/plugin-changes`) has no way to be exempted.

## Rule owners declare scope, never consumers

- **Lint barrels** (`satisfies LintContribution`, from `lint/core`):
  `outOfScope: { "<rule>": FileCategory[] }` for whole categories the rule does
  not apply to, and `closed: ["<rule>"]` for a rule that admits no exemption
  (absent from `ExemptableRuleId`, and refused by `exempt:manifests-valid`).
  Contributed rules are already out of scope in `test` and `e2e` unless listed
  in `enforceEverywhere`.
- **Checks** (`Check` from `tooling/core`): `exemptable: { "<id>": "<what
  violating it means>" }` with ids `<check-id>` or `<check-id>:<sub>`, and
  `outOfScope: FileCategory[]`. A check with no `exemptable` admits no
  exemption by construction. In `run(ctx)`:

  ```ts
  const exempt = await ctx.exempt("no-raw-websocket");
  const offenders = matches.filter((m) => !exempt.skips(m.path));
  ```

  `skips(path)` is "out of the check's scope, or exempted" and records the hit;
  `ctx.inScope(path)` is the scope half alone. Call `skips` only for a
  violation you would otherwise report.

`FileCategory` (`core/file-category.ts`) is the closed vocabulary: `test`,
`e2e`, `script`, `bin`, `cli`, `central`, `provision`, `research`, each defined
once as globs — ESLint reads the globs, checks the compiled predicate.

## Enforcement

One loader (`loadExemptions`), three consumers:

- **IDE** (`eslint.config.ts`, `exemptions: "config-off"`): each exempted
  (rule, path) is a config-level `"off"` block — no squiggle on an exempt file.
- **type-check worker** (`exemptions: "report"`): the rule runs everywhere; the
  worker drops messages an exemption covers, and reports
  `(unused-exemption)` for a FILE-level exemption on a linted file that
  suppressed nothing. Directory exemptions are only stale-checked (an
  incremental run lints part of a subtree). Every `plugins/**/exempt/**` file is
  a global lint trigger, so a manifest edit re-lints everything.
- **check runner**: `ctx.exempt(id)` lists and reads the manifests through
  `ctx.repo()`, so an input-keyed check's read-set covers their set and bytes. After `run()`, the runner
  fails the check for every exemption of its ids that matched nothing.

Checks: `exempt:manifests-valid` (stale path, invalid manifest — escaping path,
missing reason/task —, duplicate, unknown or closed rule) and
`exempt:rule-ids-in-sync` (the generated union).

## Finding exemptions

- `./singularity exempt list [--rule <id>] [--plugin <path>] [--debt]` — every
  declared exemption grouped by rule → plugin → path (kind, reason, task for
  debt), with counts per rule and a total. `--debt` is the burndown list.
- Plugin docs: an exempting plugin lists "Exempts itself from", the owner of
  the rule or check lists "Exempted by" with its debt count, and the compact
  index marks the former `[exempt]` (the `plugin-meta/facets/exemptions` facet).
- `exempt/no-path-allowlist` (this plugin's `lint/`) rejects, in `check/` and
  `lint/` files, an array or `new Set([...])` holding a repo-path string
  (`"plugins/…"`, `"research/…"`, `"cli/…"`) and `.startsWith("plugins/…")` —
  the hand-rolled lists this system replaces.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Inverted exemptions: a plugin declares, in its own exempt/index.ts, which of its files may violate which lint rule or check — with a reason, and a task when it is debt. The manifest types, the generated rule-id union, the file-category vocabulary rule owners scope by, and the one loader + hit-recording matcher the ESLint config, the type-check worker and the check runner all read.
- Cross-plugin:
  - Imported by:
    - `framework/tooling/checks`
    - `framework/tooling/lint`
- Core:
  - Exports (types):
    - `DebtExemption`
    - `ExemptableRuleId`
    - `Exemption`
    - `ExemptionIndex`
    - `ExemptionKind`
    - `ExemptionMatcher`
    - `Exemptions`
    - `FileCategory`
    - `ManifestSource`
    - `ResolvedExemption`
    - `SanctionedExemption`
  - Exports (values):
    - `categoryGlobs`
    - `covers`
    - `createExemptionIndex`
    - `describeExemption`
    - `exemptManifestPaths`
    - `FILE_CATEGORIES`
    - `FILE_CATEGORY_GLOBS`
    - `isInAnyCategory`
    - `isInCategory`
    - `isLintRuleId`
    - `loadExemptions`
    - `manifestPathError`
    - `manifestPathOf`
    - `NON_APP_FILE_CATEGORIES`
    - `resolveManifest`
    - `resolveTarget`
    - `ruleIdProblems`

<!-- AUTOGENERATED:END -->
