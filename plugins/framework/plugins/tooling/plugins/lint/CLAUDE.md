# lint

## Where a contributed rule applies

A plugin contributes rules via `plugins/<name>/lint/index.ts`; the root
`eslint.config.ts` and the `type-check` check both build from
[`core/build-lint-config.ts`](core/build-lint-config.ts), so the IDE and the
check can never enforce different sets.

Contributed rules apply repo-wide **to app code**, and are **off in test and e2e
files** — the `test` and `e2e` file categories of
[`tooling/exempt`](../exempt/CLAUDE.md) (`NON_APP_FILE_CATEGORIES`).

The reason is what these rules are: nearly all of them enforce the app's
*composition* — use the `Row` primitive, use the spacing ramp, route scroll
writes through `auto-scroll`, render collections as a DataView. A test suite and
a Playwright driver are not part of that composition; they observe the app from
outside. For `e2e/` the boundary rules go further and **forbid** importing the
primitives those rules point at (the `e2e` runtime may reach `core` and other
`e2e` barrels, never `web`) — so the rule's own suggested remedy is unreachable
from the file it fires on, and the only way out is an inline disable. A rule that
can only be satisfied by disabling it is not enforcing anything.

This does **not** relax the base config: typescript-eslint and the react-hooks /
React Compiler diagnostics still apply everywhere.

### Opting a rule back in

A rule that catches a genuine **bug** rather than a design deviation should stay
on everywhere. Declare it in the lint barrel:

```ts
export default {
  name: "promise-safety",
  rules: { "no-bare-catch": noBareCatch, /* … */ },
  enforceEverywhere: ["no-bare-catch", /* … */],
};
```

`promise-safety` opts all three of its rules back in: a test is exactly where an
unawaited promise or a swallowed error is most damaging, because it makes a suite
pass while asserting nothing. A rule id in `enforceEverywhere` that the plugin
does not define fails the config build loudly, so a typo can't silently leave a
rule off.

Type the barrel `satisfies LintContribution`. A rule owner declares only
scope: `outOfScope: { "<rule>": FileCategory[] }` and `closed: ["<rule>"]`.
Which files may violate a rule is declared by the plugin owning them, in its
own `exempt/index.ts` — see [`tooling/exempt`](../exempt/CLAUDE.md). The
owner-side `ignores` key no longer exists: a barrel carrying it is a tsc error and fails at load.

## Two kinds of rule: syntactic and type-aware

A rule is **type-aware** iff it declares `meta.docs.requiresTypeChecking:
true` (the typescript-eslint convention; build custom rules with
`ESLintUtils.RuleCreator<LintRuleDocs>` so the field type-checks). Every other
rule is **syntactic**. `isTypeAwareRule` in
[`core/build-lint-config.ts`](core/build-lint-config.ts) is the one
classifier; `LintRuleSelection.kind` and `typeAwareLintGroups` both read it.

The declaration is load-bearing: the `type-check` lint cache keys a syntactic
rule's result on the file's own text alone, and a type-aware one also on the
types the file can see (research/2026-10-17-global-lint-keyed-on-what-it-reads.md).
An undeclared rule that reads types would cache an answer that goes stale when
an imported declaration changes. Two guards stop that:

- the syntactic pass runs with the `{ none: true }` type source — no program,
  no project — so a `getParserServices` call there throws instead of answering;
- `rule-kind-safety/type-aware-rule-declared` catches the lazily-reached call
  statically: a file that reads parser services must declare the flag.

## Class rules take the shared walk — they do not copy it

A rule that reads Tailwind class tokens uses the ONE walk in
[`core/class-token-walk.ts`](core/class-token-walk.ts). The rule
takes the type by import and the value by injection — default-export a factory,
and list it under **`classRules`** (not `rules`):

```ts
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default function buildRule({ collectTokens, CLASS_ATTRS }: LintToolkit) {
  return createRule({ /* … */ });
}
```

Write `import type { … }`, never `import { type … }` — `verbatimModuleSyntax`
can keep the latter as a runtime import, which breaks config loading under jiti.
Tests run under Bun, so they build the rule with the real `lintToolkit`,
imported from `@plugins/framework/plugins/tooling/plugins/lint/core/testing`.

The toolkit also carries **`declaredUtilities`**: every custom `@utility` in
app.css, read when the config is built (`core/declared-utilities.ts`), so a rule
can tell a class that exists from one Tailwind would silently compile to
nothing (`space-ramp/no-dead-spacing`). A rule must never import a generated
manifest for such facts: `build` regenerates manifests after loading the rules,
so an imported one would be stale (`cli:codegen-manifests-not-frozen`). A file
a rule reads is listed in `LINT_DATA_FILES`, which the type-check cache treats
as a global trigger.

`class-token-walk-single-source` fails if a rule file declares `collectTokens` /
`baseClass` / `CLASS_ATTRS` / `CLASS_BUILDERS` of its own. It replaced a check
that held six hand-copied walks byte-identical: eleven *other* rules carried an
older copy outside its list and had silently drifted, so the copies could not
see a class string parked in a `const` or a style map.

The class builders the walk starts from are `cn`, `clsx`, `twMerge` and `cva`.
A `cva(...)` table's base string and variant values are classes, so every
class rule reads them (the sidebar's `text-xs` once hid there); its variant
NAMES are non-computed identifier object keys, which the walk skips rather than
resolving as aliases. A rule reports a `cva` violation at the call, so a
justified per-site disable sits above the `cva(` line and covers the table.

The walk follows a same-file identifier to the VALUE it stands for, whatever
shape that value has: a string, a map, a lookup into one (`const sz =
SIZE[s]`), a ternary, a `satisfies` wrapper, or a call — whose callee, when it
is a same-file function, stands for its return values (`const sz =
geometryFor(p, s)` → `SIZE_MAP[size]`; the avatar's raw font sizes hid there).
Member and key NAMES (`sz.box`, `{ size: … }`) are never resolved as aliases.
One stop: through an alias, the walk does not re-enter a class-builder call
(`const cls = cond ? cn(…) : …`, `buttonVariants = cva(…)`) — that call is a
check site of its own, and a second report at the use would land on a line
its disable does not cover. Parameters and imports have no in-file value.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Global ESLint rules (promise-safety) and discovery helpers for the ESLint config
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `framework/tooling/exempt.categoryGlobs`
    - `framework/tooling/exempt.FILE_CATEGORIES`
    - `framework/tooling/exempt.FileCategory`
    - `framework/tooling/exempt.isLintRuleId`
    - `framework/tooling/exempt.loadExemptions`
    - `framework/tooling/exempt.NON_APP_FILE_CATEGORIES`
    - `framework/tooling/exempt.ResolvedExemption`
    - `framework/tooling/exempt.ruleIdProblems`
  - Exports (types):
    - `BuildLintConfigOptions`
    - `ClassRuleFactory`
    - `LintContribution`
    - `LintExemptionMode`
    - `LintRuleDocs`
    - `LintRuleKind`
    - `LintRuleSelection`
    - `LintToolkit`
    - `LoadedLintContribution`
    - `ParserTypeSource`
    - `TokenNode`
  - Exports (values):
    - `baseClass`
    - `buildLintConfig`
    - `CLASS_ATTRS`
    - `CLASS_BUILDERS`
    - `collectTokenNodes`
    - `collectTokens`
    - `findPluginDirs`
    - `isLintScopeExcluded`
    - `isTypeAwareRule`
    - `LINT_CONFIG_SOURCE`
    - `LINT_DATA_FILES`
    - `LINT_SCOPE_EXCLUDE_GLOBS`
    - `lintCollectedDir`
    - `lintContributionPaths`
    - `lintDataKey`
    - `lintExemptions`
    - `lintRuleIds`
    - `loadLintContributions`
    - `typeAwareLintGroups`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `framework/tooling/codegen`
- Test helpers:
  - Core: `@plugins/framework/plugins/tooling/plugins/lint/core/testing`
    - `lintToolkit`
- Sub-plugins:
  - **`agent-origin-safety`** — Lint rule keeping an e2e script's own Node-side calls to the app under test marked with the agent-origin headers, so the writes they cause stay attributable and revertible.
  - **`aria-safety`** — aria-safety lint rule: no-orphan-composite-role
  - **`bun-safety`** — bun-safety lint rule: no-declare-identifier
  - **`button-safety`** — button-safety lint rules: no-async-raw-button, no-redundant-cursor-pointer
  - **`caret-trigger-safety`** — caret-trigger-safety lint rule: no-adhoc-caret-trigger
  - **`check-runner-safety`** — check-runner-safety lint rule: no-adhoc-check-runner
  - **`context-safety`** — context-safety lint rule: no-unstable-context-value
  - **`detached-work-safety`** — detached-work-safety lint rule: no-untracked-detached-work
  - **`dom-access-safety`** — dom-access-safety lint rule: no-module-scope-dom
  - **`dom-selection-safety`** — dom-selection-safety lint rule: no-raw-selection-range
  - **`element-type-safety`** — element-type-safety lint rule: no-post-mount-element-type
  - **`entity-projection-safety`** — entity-projection-safety lint rule: no-hand-rolled-entity-projection
  - **`format-safety`** — format-safety lint rule: no-adhoc-prettier
  - **`git-grep-safety`** — git-grep-safety lint rule: no-adhoc-git-grep
  - **`guard-path-safety`** — guard-path-safety lint rule: no-adhoc-path-resolve
  - **`hover-reveal-safety`** — hover-reveal-safety lint rule: no-uncoupled-hover-reveal
  - **`icon-safety`** — icon-safety lint rules: no-lucide-react
  - **`import-scan-safety`** — import-scan-safety lint rule: no-adhoc-import-scan
  - **`intersection-observer-safety`** — intersection-observer-safety lint rule: no-raw-intersection-observer
  - **`marker-scan-safety`** — marker-scan-safety lint rule: no-adhoc-marker-scan
  - **`namespace-identity`** [exempt] — Two lint rules over one mistake — answering 'which namespace?' with something that is not one: no-laundered-checkout-namespace bans casting a checkout directory name to a Namespace, and…
  - **`polling-safety`** — polling-safety lint rule: no-refetch-interval
  - **`promise-safety`** — promise-safety lint rules: no-floating-promises, no-bare-catch
  - **`reactive-server-io`** — reactive-server-io lint rule: no-reactive-server-io
  - **`repo-walk-safety`** — repo-walk-safety lint rule: no-adhoc-repo-walk
  - **`resize-observer-safety`** — resize-observer-safety lint rule: no-raw-resize-observer
  - **`route-teardown-safety`** — route-teardown-safety lint rule: no-unroute
  - **`rule-kind-safety`** — rule-kind-safety lint rule: type-aware-rule-declared (a lint rule that reads parser services declares meta.docs.requiresTypeChecking: true)
  - **`runtime-isolation`** — runtime-isolation lint rule: no-deep-own-folder-import
  - **`scroll-safety`** — scroll-safety lint rules: no-adhoc-scroll-into-view, no-adhoc-scroll-write
  - **`sink-safety`** — sink-safety lint rules: no-adhoc-file-sink, no-adhoc-profiler-seam
  - **`trigger-render-safety`** — trigger-render-safety lint rule: no-provider-trigger-render
  - **`watcher-safety`** — watcher-safety lint rules: no-direct-parcel-watcher (only the file-watcher engine loads @parcel/watcher), no-raw-fs-watch (no fs.watch / watchFile / fs.promises.watch / chokidar in host-process code…

<!-- AUTOGENERATED:END -->
