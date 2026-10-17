/**
 * Single source of truth for the repo's flat ESLint config.
 *
 * Two consumers build the same rules/plugins from here, differing only in how
 * the parser obtains TypeScript type information and how exemptions apply:
 *
 *   - the root `eslint.config.ts` (editor/IDE + ad-hoc `bunx eslint`) passes
 *     `{ projectService: true }` — typescript-eslint discovers each file's
 *     tsconfig and builds its own program — and `exemptions: "config-off"`;
 *   - the `type-check` check's per-target worker passes `{ programs: [program] }`
 *     — typescript-eslint REUSES a program the worker already built for `tsc`
 *     diagnostics, so the type-program is constructed once, not twice — and
 *     `exemptions: "report"`.
 *
 * Keeping both paths on this one builder means a rule/plugin/exemption change
 * applies identically to the IDE and the check. The contribution loader is
 * shared too (and fails loudly on a dropped contribution), so the type-aware
 * check can never silently enforce a different rule set than the editor.
 *
 * Loaded under Bun (the worker) and under a jiti carrying the `@plugins` alias
 * (`eslint.config.ts`), so `@plugins/*` imports resolve in both.
 */
import type TsEslintPlugin from "@typescript-eslint/eslint-plugin";
import type TsEslintParser from "@typescript-eslint/parser";
import type { ESLint, Linter } from "eslint";
import type ReactHooksPlugin from "eslint-plugin-react-hooks";
import type { Program } from "typescript";
import {
  FILE_CATEGORIES,
  NON_APP_FILE_CATEGORIES,
  categoryGlobs,
  isLintRuleId,
  loadExemptions,
  ruleIdProblems,
  type FileCategory,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { lintEntries } from "./lint.generated";
import { LINT_SCOPE_EXCLUDE_GLOBS } from "./lint-scope-exceptions";
import { createLintToolkit, type LintToolkit } from "./class-token-walk";
import { readDeclaredUtilities } from "./declared-utilities";

// Loaded lazily: importing anything from this module's barrel
// (`lint/core/index.ts`) — even a leaf helper like `isLintScopeExcluded` —
// forces this file's top level to evaluate (a static re-export runs the
// whole module graph before the barrel is usable). `type-check`'s
// `import-graph.ts` does exactly that from the MAIN thread, well before any
// check's `run()` — so a top-level `import` of these three packages here paid
// their cost on every `./singularity check` pass, for every check, not just
// `type-check`'s own worker. Each is invariant for the process's lifetime —
// not a tree-derived fact — so a per-process memo is safe (unlike caching a
// tree fact across a whole process).
let tsPluginPromise: Promise<typeof TsEslintPlugin> | undefined;
function loadTsPlugin(): Promise<typeof TsEslintPlugin> {
  return (tsPluginPromise ??= import("@typescript-eslint/eslint-plugin").then(
    (m) => m.default,
  ));
}
let tsParserPromise: Promise<typeof TsEslintParser> | undefined;
function loadTsParser(): Promise<typeof TsEslintParser> {
  return (tsParserPromise ??= import("@typescript-eslint/parser").then(
    (m) => m.default,
  ));
}
let reactHooksPromise: Promise<typeof ReactHooksPlugin> | undefined;
function loadReactHooks(): Promise<typeof ReactHooksPlugin> {
  return (reactHooksPromise ??= import("eslint-plugin-react-hooks").then(
    (m) => m.default,
  ));
}

let builtinRulesPromise: Promise<Record<string, unknown>> | undefined;
function loadBuiltinRules(): Promise<Record<string, unknown>> {
  return (builtinRulesPromise ??= import("eslint/use-at-your-own-risk").then(
    (m) => Object.fromEntries(m.builtinRules),
  ));
}

/** The rule modules a base rule id (`baseRuleEntries`) is looked up in. */
interface BaseRulePlugins {
  tsPlugin: typeof TsEslintPlugin;
  reactHooks: typeof ReactHooksPlugin;
  /** eslint core's rules, by id. */
  builtinRules: Record<string, unknown>;
}

/**
 * The rule module a base rule id names: `@typescript-eslint/<r>`,
 * `react-hooks/<r>`, or an eslint core `<r>`. Throws on an id none of them
 * defines — classifying a rule nobody defines would silently give it a kind.
 */
function baseRuleModule(id: string, plugins: BaseRulePlugins): unknown {
  const slash = id.lastIndexOf("/");
  const ns = id.slice(0, Math.max(slash, 0));
  const rules: Record<string, unknown> | undefined = {
    "": plugins.builtinRules,
    "@typescript-eslint": plugins.tsPlugin.rules,
    "react-hooks": plugins.reactHooks.rules,
  }[ns];
  const rule = rules?.[id.slice(slash + 1)];
  if (rule === undefined) {
    throw new Error(
      `[eslint] base rule "${id}" is not defined by eslint core, @typescript-eslint or react-hooks — cannot classify its kind`,
    );
  }
  return rule;
}

/**
 * What a plugin's `lint/index.ts` default-exports. Write the barrel as
 * `export default { … } satisfies LintContribution`, so a misspelled or
 * retired key is a type error before it is a load error.
 *
 * The owner declares the rule's SCOPE here and never names a consumer: which
 * files may violate a rule is declared by the plugin that owns those files, in
 * its own `exempt/index.ts` (see `tooling/exempt`).
 */
export interface LintContribution {
  /** ESLint plugin namespace: the rules are enabled as `<name>/<rule>`. */
  name: string;
  rules: Record<string, unknown>;
  /**
   * Class rules, declared as FACTORIES rather than rule modules. A rule file
   * that reads class tokens default-exports `(toolkit) => rule` and receives
   * the one shared walk from here. Kept a separate key from `rules` so a
   * factory is never confused with ESLint's legacy function-shaped rule module
   * — the distinction is declared, not sniffed. See `./class-token-walk.ts`.
   */
  classRules?: Record<string, unknown>;
  /**
   * Rule ids that stay enforced in test/e2e files (`NON_APP_FILE_CATEGORIES`),
   * which contributed rules are otherwise off in. Opt in for rules that catch a
   * real BUG anywhere they fire — a floating promise, a swallowed error — as
   * opposed to an app-architecture deviation, which is meaningless in a test
   * driver.
   */
  enforceEverywhere?: string[];
  /**
   * File categories a rule does not apply to, keyed by rule id — rule scope,
   * not an exemption (`tooling/exempt`'s `FileCategory`). Adds to the default
   * test/e2e scope; does not override `enforceEverywhere`.
   */
  outOfScope?: Record<string, readonly FileCategory[]>;
  /**
   * Rule ids that admit no exemption: an `exempt/index.ts` naming one is
   * refused (and the id is absent from `ExemptableRuleId`, so tsc refuses it
   * first).
   */
  closed?: string[];
}

/**
 * This file, repo-relative: the root of the lint ENGINE's import closure, which
 * the type-check lint cache folds into every cached result's key (what this
 * builder enables, and everything it imports, can change any file's result).
 */
export const LINT_CONFIG_SOURCE =
  "plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts";

/**
 * Every lint contribution's plugin path (`relPath` of its loaded form), without
 * loading any of them — what the type-check lint cache keys one rule group on
 * each.
 */
export function lintContributionPaths(): string[] {
  return lintEntries.map((e) => e.pluginPath);
}

/** A loaded contribution: the barrel, with its class rules built into `rules`. */
export interface LoadedLintContribution {
  /** Relative path under plugins/, e.g. "welcome" or "conversations/plugins/conversation-view". */
  relPath: string;
  name: string;
  rules: Record<string, unknown>;
  enforceEverywhere: string[];
  outOfScope: Record<string, readonly FileCategory[]>;
  closed: string[];
}

/**
 * Construct a plugin's class rules by handing each factory the shared toolkit.
 * A non-function under `classRules` is the one mistake this shape allows, and
 * it fails loudly rather than registering something ESLint would ignore.
 */
function buildClassRules(
  pluginPath: string,
  classRules: Record<string, unknown>,
  toolkit: LintToolkit,
): { rules: Record<string, unknown> } | { error: string } {
  const built: Record<string, unknown> = {};
  for (const [id, factory] of Object.entries(classRules)) {
    if (typeof factory !== "function") {
      return {
        error: `${pluginPath}/lint — classRules["${id}"] must be a factory (toolkit) => rule, got ${typeof factory}`,
      };
    }
    built[id] = (factory as (t: LintToolkit) => unknown)(toolkit);
  }
  return { rules: built };
}

/**
 * Load every plugin's `lint/index.ts` contribution. Fail loudly: a dropped
 * contribution silently stops enforcing its rules.
 */
export async function loadLintContributions(
  root: string,
): Promise<LoadedLintContribution[]> {
  const toolkit = createLintToolkit(readDeclaredUtilities(root));
  const results = await Promise.allSettled(lintEntries.map((e) => e.loader()));
  const contributions: LoadedLintContribution[] = [];
  const failures: string[] = [];
  const isCategory = (c: unknown): c is FileCategory =>
    (FILE_CATEGORIES as readonly unknown[]).includes(c);
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const e = lintEntries[i]!;
    if (r.status === "rejected") {
      failures.push(
        `${e.pluginPath}/lint — ${(r.reason as Error)?.message ?? String(r.reason)}`,
      );
      continue;
    }
    const def = (r.value as { default?: Partial<LintContribution> }).default;
    if (!def?.name || !def.rules) {
      failures.push(
        `${e.pluginPath}/lint — default export missing { name, rules }`,
      );
      continue;
    }
    // The owner-side `ignores` allowlist is gone: which files may violate a
    // rule is declared by the plugin owning them, in its `exempt/index.ts`.
    if ("ignores" in def) {
      failures.push(
        `${e.pluginPath}/lint — \`ignores\` is no longer supported: the plugin that owns an exempted file declares it in its own plugins/<plugin>/exempt/index.ts (see plugins/framework/plugins/tooling/plugins/exempt/CLAUDE.md); a whole category of files is \`outOfScope\`, and a rule that admits no exemption is \`closed\``,
      );
      continue;
    }
    // Class-rule factories are constructed with the shared token walk, then
    // merged into the plugin's rule set — from here on they are ordinary rules.
    const built = buildClassRules(e.pluginPath, def.classRules ?? {}, toolkit);
    if ("error" in built) {
      failures.push(built.error);
      continue;
    }
    const rules = { ...def.rules, ...built.rules };
    // A typo'd rule id in enforceEverywhere / outOfScope / closed would
    // silently change nothing — exactly the failure each exists to prevent.
    const outOfScope = def.outOfScope ?? {};
    const named: (readonly [key: string, id: string])[] = [
      ...(def.enforceEverywhere ?? []).map(
        (id) => ["enforceEverywhere", id] as const,
      ),
      ...Object.keys(outOfScope).map((id) => ["outOfScope", id] as const),
      ...(def.closed ?? []).map((id) => ["closed", id] as const),
    ];
    const unknown = named.filter(([, id]) => !(id in rules));
    if (unknown.length > 0) {
      failures.push(
        `${e.pluginPath}/lint — names rule(s) this plugin does not define: ${unknown.map(([k, id]) => `${k} "${id}"`).join(", ")}`,
      );
      continue;
    }
    const badCategories = Object.entries(outOfScope).flatMap(([id, cats]) =>
      cats.filter((c) => !isCategory(c)).map((c) => `${id}: "${String(c)}"`),
    );
    if (badCategories.length > 0) {
      failures.push(
        `${e.pluginPath}/lint — outOfScope names unknown file categories (${badCategories.join(", ")}); known: ${FILE_CATEGORIES.join(", ")}`,
      );
      continue;
    }
    contributions.push({
      relPath: e.pluginPath,
      name: def.name,
      rules,
      enforceEverywhere: def.enforceEverywhere ?? [],
      outOfScope,
      closed: def.closed ?? [],
    });
  }
  if (failures.length > 0) {
    throw new Error(
      `[eslint] failed to load lint contributions:\n  ${failures.join("\n  ")}`,
    );
  }
  return contributions;
}

/**
 * The live lint rule ids (`<ns>/<rule>`) and the closed subset — what an
 * exemption naming a lint rule is validated against.
 */
export function lintRuleIds(contributions: readonly LoadedLintContribution[]): {
  known: Set<string>;
  closed: Set<string>;
} {
  const known = new Set<string>();
  const closed = new Set<string>();
  for (const c of contributions) {
    for (const id of Object.keys(c.rules)) known.add(`${c.name}/${id}`);
    for (const id of c.closed) closed.add(`${c.name}/${id}`);
  }
  return { known, closed };
}

/**
 * The exemptions that name a lint rule, validated against the live rule set.
 * Throws on an unknown or closed id: in "config-off" mode it would otherwise
 * switch off a rule that does not exist, and in "report" mode suppress nothing
 * with no way to tell.
 */
export function lintExemptions(
  exemptions: readonly ResolvedExemption[],
  contributions: readonly LoadedLintContribution[],
): ResolvedExemption[] {
  const lint = exemptions.filter((e) => isLintRuleId(e.rule));
  const problems = ruleIdProblems(lint, lintRuleIds(contributions));
  if (problems.length > 0) {
    throw new Error(
      `[eslint] invalid lint exemptions:\n  ${problems.join("\n  ")}`,
    );
  }
  return lint;
}

/**
 * The rule-docs fields this repo reads, for a rule's `meta.docs` — pass it to
 * `ESLintUtils.RuleCreator<LintRuleDocs>(…)`. `requiresTypeChecking` is the
 * typescript-eslint convention (its own rules set it): a rule that reads types
 * declares `true`, and the lint rule `rule-kind-safety/type-aware-rule-declared`
 * holds every rule calling `getParserServices` to it.
 */
export interface LintRuleDocs {
  requiresTypeChecking?: boolean;
}

/** A rule's kind: whether its answer depends on type information. */
export type LintRuleKind = "syntactic" | "type-aware";

/**
 * The ONE rule-kind classifier: a rule is type-aware iff it declares
 * `meta.docs.requiresTypeChecking: true`. Everything else is syntactic — its
 * result is a function of the file's own text, which is what lets the
 * type-check lint cache key it on that text alone. An undeclared type-aware
 * rule cannot cache a wrong answer: the syntactic pass runs with
 * `{ none: true }`, where its `getParserServices` throws.
 */
export function isTypeAwareRule(rule: unknown): boolean {
  if (typeof rule !== "object" || rule === null) return false;
  const docs = (
    rule as { meta?: { docs?: { requiresTypeChecking?: unknown } } }
  ).meta?.docs;
  return docs?.requiresTypeChecking === true;
}

function isRuleOfKind(rule: unknown, kind: LintRuleKind | "all"): boolean {
  return kind === "all" || isTypeAwareRule(rule) === (kind === "type-aware");
}

/**
 * How the parser resolves TypeScript type information for type-aware rules.
 * `{ none: true }` resolves none: only syntactic rules may run under it, and a
 * type-aware one fails loudly (see `isTypeAwareRule`).
 */
export type ParserTypeSource =
  { projectService: true } | { programs: Program[] } | { none: true };

/**
 * How `exempt/` manifests apply:
 *   - "config-off" — each exempted (rule, path) becomes an `"off"` config block,
 *     so the editor shows no squiggle on an exempt file. An exemption that
 *     suppresses nothing is invisible in this mode.
 *   - "report" — the rule stays on everywhere and the CALLER drops the messages
 *     an exemption covers (the type-check worker, through `createExemptionIndex`
 *     over `loadExemptions()`), so it can also report an exemption that
 *     suppressed nothing.
 */
export type LintExemptionMode = "config-off" | "report";

/**
 * A subset of the rules to enable: the builder's own rules (`base` —
 * typescript-eslint, react-hooks, eslint core) and/or the named contributions,
 * by plugin path. The parser and its type source are configured either way.
 */
export interface LintRuleSelection {
  base: boolean;
  contributions: ReadonlySet<string>;
  /**
   * Which rules of the selected groups to enable, by `isTypeAwareRule`: the
   * type-check worker runs the syntactic ones without a program (`{ none:
   * true }`) and the type-aware ones with it.
   */
  kind: LintRuleKind | "all";
}

export interface BuildLintConfigOptions {
  /** Repo root — anchors `tsconfigRootDir`. */
  root: string;
  /** projectService (IDE/CLI) or a pre-built program set (type-check worker). */
  typeSource: ParserTypeSource;
  exemptions: LintExemptionMode;
  /**
   * Enable only these rules (default: all). The type-check worker re-runs only
   * the rule groups whose cached result is stale for a file; a contribution
   * left out is not even registered, so no block below names its rules.
   */
  rules?: LintRuleSelection;
}

/**
 * React Compiler / Rules-of-React diagnostic rules, set WARN-FIRST.
 *
 * The React Compiler auto-memoizes components, but it *silently bails* on any
 * component that breaks the Rules of React — such components compile to plain
 * pass-throughs with no memoization. These eslint rules are the ONLY way to
 * find and count those silent bails, so the warning COUNT is the compiler's
 * coverage / silent-bail metric driving the adopt-vs-not decision.
 *
 * They ship in `eslint-plugin-react-hooks`'s `recommended-latest` flat config
 * (the standalone `eslint-plugin-react-compiler` is deprecated; its rules were
 * merged into eslint-plugin-react-hooks v6+). We read them off the installed
 * version programmatically — never hardcode the list, which drifts per version.
 *
 * Severity policy — FINAL STATE (warn-first ratchet complete, 2026-06-24):
 *   - Every recommended-latest rule is spread in at "warn" first.
 *   - EVERY currently-known rule is then RE-PINNED to "error" below (the explicit
 *     keys come after the spread, so they win). The burndown program drove the
 *     whole web tree to zero, so all 17 rules are now enforced — a new violation
 *     fails `./singularity check` instead of silently eroding compiler coverage.
 *   - The "warn" spread therefore now only matters as the ON-RAMP for a rule a
 *     FUTURE eslint-plugin-react-hooks version adds: a newly-shipped rule lands at
 *     "warn" by default (green check + a triageable count) rather than instantly
 *     breaking the build, preserving the warn-first-then-ratchet discipline.
 *
 * Fails loudly (below) on version skew rather than silently enabling nothing.
 */
function compilerDiagnosticRulesAsWarn(
  reactHooks: Awaited<ReturnType<typeof loadReactHooks>>,
): Record<string, Linter.RuleEntry> {
  const recommended = (
    reactHooks as unknown as {
      configs?: { "recommended-latest"?: { rules?: Record<string, unknown> } };
    }
  ).configs?.["recommended-latest"];
  if (!recommended?.rules) {
    throw new Error(
      "[eslint] eslint-plugin-react-hooks: configs['recommended-latest'].rules is missing — " +
        "version skew (expected v6+ where the React Compiler diagnostics ship there). " +
        "Cannot enable the compiler rules; refusing to silently enable nothing.",
    );
  }
  // Spread every rule from recommended-latest, forcing each to "warn".
  return Object.fromEntries(
    Object.keys(recommended.rules).map((ruleId) => [ruleId, "warn"] as const),
  );
}

/**
 * The builder's own rules (typescript-eslint, react-hooks, eslint core) and
 * their severities — the ONE table both `buildLintConfig` and
 * `typeAwareLintGroups` read, so the config and the type-aware classification
 * of the base group cannot disagree.
 */
function baseRuleEntries(
  reactHooks: Awaited<ReturnType<typeof loadReactHooks>>,
): Record<string, Linter.RuleEntry> {
  return {
    "@typescript-eslint/no-floating-promises": "off",
    "@typescript-eslint/no-misused-promises": [
      "error",
      {
        checksVoidReturn: { attributes: false },
      },
    ],
    "@typescript-eslint/switch-exhaustiveness-check": "error",
    "@typescript-eslint/no-unnecessary-condition": [
      "warn",
      {
        allowConstantLoopConditions: true,
      },
    ],
    "@typescript-eslint/await-thenable": "error",
    // React Compiler / Rules-of-React diagnostics, warn-first (see
    // compilerDiagnosticRulesAsWarn above). Spread FIRST so the two
    // explicit "error" pins below win the merge.
    ...compilerDiagnosticRulesAsWarn(reactHooks),
    "react-hooks/rules-of-hooks": "error",
    // exhaustive-deps treats the `settings["react-hooks"].stableHooks` list
    // (buildLintConfig's base block) as known-stable returns (like a bare useRef), via our patch to
    // isStableKnownHookValue (patches/eslint-plugin-react-hooks@*.patch) —
    // so useLatestRef/useEventCallback refs need not be listed in dep arrays.
    "react-hooks/exhaustive-deps": "error",
    // Coverage-blocking React Compiler rules — RATCHETED warn→error once the
    // codebase was driven to zero (2026-06-23). These are the diagnostics
    // that make the compiler SILENTLY BAIL on (skip memoizing) a component;
    // enforcing them at error keeps compiler coverage complete — a new bail
    // fails `./singularity check` instead of silently eroding coverage.
    // Genuine exemptions opt out at the site: a `"use no memo"` directive
    // and/or an inline `// eslint-disable-next-line react-hooks/<rule> -- …`
    // (e.g. the @tanstack/react-virtual incompatibility in primitives/
    // virtual-rows). `react-hooks/refs` was likewise RATCHETED warn→error in
    // Phase 2 (2026-06-23) once its burndown hit zero: the latest-value-ref
    // idiom moved into the `useLatestRef`/`useEventCallback` primitive
    // (primitives/latest-ref), which carries the one sanctioned disable;
    // @dnd-kit / auto-scroll library refs are destructured at the call site
    // (member access on a ref-bearing hook return is what trips the rule);
    // genuine anti-patterns were refactored; and the few intentional
    // render-time machines (use-tab-presence, use-cursor-pagination, the
    // build-once markdown/overlay memos) carry an inline `react-hooks/refs`
    // disable. `react-hooks/set-state-in-effect` was likewise RATCHETED
    // warn→error on 2026-06-24 once its burndown hit zero: anti-patterns
    // were refactored (props-to-state → key= remount, default-selection /
    // derived state → derive in render), fetch/subscription effects migrated
    // to useEndpoint / useSyncExternalStore or the shared useHighlightedHtml
    // primitive, and the genuinely-stateful remainder (animation/temporal
    // machines, NDJSON streams, optimistic-cleanup, primitive internals)
    // carries an inline `react-hooks/set-state-in-effect` disable. See
    // research/2026-06-24-global-react-compiler-set-state-burndown.md (and the
    // refs burndown research/2026-06-23-global-react-compiler-refs-burndown.md).
    "react-hooks/purity": "error",
    "react-hooks/immutability": "error",
    "react-hooks/use-memo": "error",
    "react-hooks/void-use-memo": "error",
    "react-hooks/static-components": "error",
    "react-hooks/preserve-manual-memoization": "error",
    "react-hooks/incompatible-library": "error",
    "react-hooks/refs": "error",
    "react-hooks/set-state-in-effect": "error",
    // Final 6 diagnostics RATCHETED warn→error on 2026-06-24. Their scan count
    // was ALREADY 0 (no burndown needed — the coverage / refs / set-state-in-
    // effect phases left the whole web tree clean), so all six promote together.
    // `set-state-in-render` (unconditional render-phase setState = re-render
    // loop) and `unsupported-syntax` (the compiler SILENTLY BAILS on it = lost
    // coverage) are the bug/coverage-bearing ones; `globals` / `error-boundaries`
    // / `config` / `gating` are rare-but-correct guards (`gating` is permanently
    // 0 — we don't use compiler feature-gating). With these, ALL react-hooks
    // compiler diagnostics are now enforced at error — completing the compliance
    // program; see research/2026-06-24-global-react-compiler-final-rules-ratchet.md.
    "react-hooks/set-state-in-render": "error",
    "react-hooks/unsupported-syntax": "error",
    "react-hooks/globals": "error",
    "react-hooks/error-boundaries": "error",
    "react-hooks/config": "error",
    "react-hooks/gating": "error",
    "no-constant-binary-expression": "error",
    eqeqeq: ["error", "smart"],
    "no-template-curly-in-string": "error",
  };
}

/** Build the full flat config array (base + plugin rules + per-rule exemptions). */
export async function buildLintConfig(
  opts: BuildLintConfigOptions,
): Promise<Linter.Config[]> {
  const { root, typeSource, rules: selection } = opts;
  const [allContributions, exemptions, tsPlugin, tsParser, reactHooks] =
    await Promise.all([
      loadLintContributions(root),
      loadExemptions(),
      loadTsPlugin(),
      loadTsParser(),
      loadReactHooks(),
    ]);
  // Validated in BOTH modes, so a manifest naming a dead or closed rule fails
  // the IDE config and the check alike.
  const lintExempt = lintExemptions(exemptions, allContributions);
  const allBaseRules = baseRuleEntries(reactHooks);
  let contributions = allContributions;
  let baseRules = allBaseRules;
  if (selection !== undefined) {
    const { kind } = selection;
    const plugins: BaseRulePlugins = {
      tsPlugin,
      reactHooks,
      builtinRules: await loadBuiltinRules(),
    };
    // A rule left out is not registered, so no scope block below names it.
    contributions = allContributions
      .filter((c) => selection.contributions.has(c.relPath))
      .map((c) => ({
        ...c,
        rules: Object.fromEntries(
          Object.entries(c.rules).filter(([, rule]) =>
            isRuleOfKind(rule, kind),
          ),
        ),
      }))
      .filter((c) => Object.keys(c.rules).length > 0);
    baseRules = !selection.base
      ? {}
      : Object.fromEntries(
          Object.entries(allBaseRules).filter(([id]) =>
            isRuleOfKind(baseRuleModule(id, plugins), kind),
          ),
        );
  }

  const parserOptions: Record<string, unknown> = {
    ecmaVersion: "latest",
    sourceType: "module",
    tsconfigRootDir: root,
    // projectService discovers each file's tsconfig; programs supplies
    // pre-built ones (project must be off so the programs aren't overridden) —
    // a file in neither errors loudly. `none` configures no type source at
    // all: the file parses standalone, and a rule asking for types
    // (`ESLintUtils.getParserServices`) throws instead of answering.
    ...("projectService" in typeSource
      ? { projectService: true }
      : "programs" in typeSource
        ? { programs: typeSource.programs, project: null }
        : { project: null }),
  };

  const baseConfigs: Linter.Config[] = [
    {
      files: ["**/*.{ts,tsx}"],
      // A disable directive that suppresses nothing is litter: it hides the fact
      // that the rule stopped applying, and it survives every later refactor
      // because nothing contradicts it. `error` (not `warn`) is load-bearing —
      // the type-check worker keeps only severity 2, so `warn` would be a
      // silent no-op here, which is exactly how the dead ones accumulated.
      linterOptions: { reportUnusedDisableDirectives: "error" },
      languageOptions: {
        parser: tsParser as unknown as Linter.Parser,
        parserOptions: parserOptions as Linter.ParserOptions,
      },
      plugins: {
        "@typescript-eslint": tsPlugin as unknown as ESLint.Plugin,
        "react-hooks": reactHooks as unknown as ESLint.Plugin,
      },
      settings: {
        "react-hooks": {
          // Hooks whose return is referentially stable for the component's whole
          // lifetime, so exhaustive-deps treats them like a bare useRef (neither
          // required nor flagged in a dep array). Consumed by our patch to
          // isStableKnownHookValue (patches/eslint-plugin-react-hooks@*.patch).
          // Append a name here when a new stable-returning primitive lands — that
          // is the ONLY step a future primitive needs.
          stableHooks: ["useLatestRef", "useEventCallback"],
        },
      },
      rules: baseRules,
    },
    {
      ignores: [
        // BUILD OUTPUT — every one of these is a `.gitignore` pattern, restated
        // here only because ESLint's own file discovery cannot read that file.
        //
        // This list gates NOTHING. The `type-check` check never uses ESLint's
        // discovery: it hands `Linter.verify` an explicit file list built from
        // `listRepoFiles`, which asks git. So these entries only shape what a
        // stray `bunx eslint .` and the editor integration walk into, where
        // drift costs a squiggle rather than a red check. Do not add source
        // policy here — that goes in `lint-scope-exceptions.ts`.
        //
        // (`@eslint/compat`'s `includeIgnoreFile` would collapse these into
        // `.gitignore` outright. It is not a dependency of this repo today.)
        "**/node_modules/**",
        "**/dist/**",
        "**/.git/**",
        "**/.cache/**",
        "**/.check-*/**",
        ".claude/worktrees/**",
        "plugins/framework/plugins/web-core/dist/**",
        // LINT SCOPE — tracked, committed files deliberately out of scope. The
        // one list the check shares, so its file set and ESLint's cannot
        // disagree about a real source file the way they did over
        // `prototypes/**`.
        ...LINT_SCOPE_EXCLUDE_GLOBS,
      ],
    },
  ];

  const pluginConfigs: Linter.Config[] = contributions.map((c) => ({
    files: ["**/*.{ts,tsx}"],
    plugins: {
      [c.name]: { rules: c.rules },
    } as unknown as Linter.Config["plugins"],
    rules: Object.fromEntries(
      Object.keys(c.rules).map(
        (ruleId) => [`${c.name}/${ruleId}`, "error"] as const,
      ),
    ),
  }));

  // A contributed rule's scope: off in test/e2e files (NON_APP_FILE_CATEGORIES)
  // unless the plugin opted it back in via enforceEverywhere, and off in every
  // category its owner declared `outOfScope`. One block per (rule, category
  // set), all built from the one category vocabulary.
  const scopeConfigs: Linter.Config[] = contributions.flatMap((c) => {
    const enforced = new Set(c.enforceEverywhere);
    return Object.keys(c.rules).flatMap((ruleId) => {
      const categories = [
        ...(enforced.has(ruleId) ? [] : NON_APP_FILE_CATEGORIES),
        ...(c.outOfScope[ruleId] ?? []),
      ];
      if (categories.length === 0) return [];
      return [
        {
          files: categoryGlobs(categories),
          rules: { [`${c.name}/${ruleId}`]: "off" },
        } as Linter.Config,
      ];
    });
  });

  // "config-off": one block per exempted (rule, target). A target is a file or
  // a directory; naming both spellings covers either without a stat.
  const exemptConfigs: Linter.Config[] =
    opts.exemptions === "config-off"
      ? lintExempt.map(
          (e) =>
            ({
              files: [e.target, `${e.target}/**`],
              rules: { [e.rule]: "off" },
            }) as Linter.Config,
        )
      : [];

  return [...baseConfigs, ...pluginConfigs, ...scopeConfigs, ...exemptConfigs];
}

function isRuleEntryOff(entry: Linter.RuleEntry): boolean {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return severity === "off" || severity === 0;
}

/**
 * Which rule groups hold at least one ENABLED type-aware rule: `base` when a
 * configured base rule not set "off" is, and the `relPath` of every
 * contribution with one. Read off the same loaders, base table and classifier
 * as `buildLintConfig`, so a group named here is exactly a group whose
 * `kind: "type-aware"` selection registers a rule.
 */
export async function typeAwareLintGroups(
  root: string,
): Promise<{ base: boolean; contributions: Set<string> }> {
  const [contributions, tsPlugin, reactHooks, builtinRules] = await Promise.all(
    [
      loadLintContributions(root),
      loadTsPlugin(),
      loadReactHooks(),
      loadBuiltinRules(),
    ],
  );
  const plugins: BaseRulePlugins = { tsPlugin, reactHooks, builtinRules };
  const base = Object.entries(baseRuleEntries(reactHooks)).some(
    ([id, entry]) =>
      !isRuleEntryOff(entry) && isTypeAwareRule(baseRuleModule(id, plugins)),
  );
  return {
    base,
    contributions: new Set(
      contributions
        .filter((c) => Object.values(c.rules).some(isTypeAwareRule))
        .map((c) => c.relPath),
    ),
  };
}
