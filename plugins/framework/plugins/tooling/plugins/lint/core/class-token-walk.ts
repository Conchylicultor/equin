import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

/**
 * The ONE class-token walk, shared by every `no-adhoc-*` class rule.
 *
 * ## Why this is injected rather than imported
 *
 * A `plugins/<name>/lint/*.ts` rule file is dual-loaded: under **jiti** (which
 * loads `eslint.config.ts` and cannot resolve the `@plugins/*` tsconfig alias)
 * and under **Bun** (the type-check worker, where the alias works). So a rule
 * file cannot `import` a runtime value from another plugin — which is why this
 * walk used to be hand-copied into seventeen rule files, six of them fenced by
 * sentinels and held together by a byte-comparison check while the other eleven
 * silently drifted onto an older, weaker copy that resolved no identifiers at
 * all.
 *
 * The constraint binds runtime values only. **jiti erases `import type`**, so a
 * rule file takes the TYPE from here and the VALUE by injection: it default-
 * exports a factory `(toolkit: LintToolkit) => rule`, its plugin's `lint/index.ts`
 * lists it under `classRules`, and `buildLintConfig` calls it with the toolkit
 * built here. Rule files must therefore write `import type { … }` — never
 * `import { type … }`, which `verbatimModuleSyntax` can preserve as a runtime
 * import that jiti would then try (and fail) to resolve.
 *
 * A rule that declared its own walk would be back where we started, so
 * `./equin check class-token-walk-single-source` fails if any rule file
 * declares one.
 */

/**
 * JSX attribute names whose value is a class-name string. `className`/`class`
 * are React's and HTML's own; the `*ClassName` suffix is the pass-through
 * convention (`panelClassName`, `itemClassName`, `wrapperClassName`,
 * `trackClassName`) a component uses to forward classes to an inner element.
 * Those forwarded strings style a real element exactly like `className` does.
 */
export const CLASS_ATTRS = /^(?:class|className)$|ClassName$/;

/**
 * Class-builder calls whose string arguments are class-name strings. `cva`
 * counts: its base string and every variant value are classes (the sidebar's
 * `text-xs` once hid in a `cva` table). Its variant NAMES are object keys the
 * walk skips (see {@link isVariantNameKey}), and its `defaultVariants` values
 * (`"default"`, `"sm"`) are variant names, not utilities, so no rule matches
 * them.
 */
export const CLASS_BUILDERS = new Set(["cn", "clsx", "twMerge", "cva"]);

/**
 * Is this child slot a NAME rather than a value? Two shapes:
 *
 *   - a non-computed identifier KEY of an object property (`{ size: … }`,
 *     cva's `variants` / `size` / `defaultVariants`);
 *   - a non-computed member PROPERTY (`sz.box`, `styles.title`).
 *
 * Either is a name, never a class, so the walk must not resolve it as an alias
 * — a same-file binding that happens to share the name (`const size =
 * "text-sm"`, `const box = …`) would otherwise be harvested. A string-literal
 * key (`clsx({ "text-x": cond })`) IS a class and is still harvested; so is the
 * property's value, shorthand included, and a computed member's key
 * (`SIZE[size]`).
 */
function isNameSlot(node: TSESTree.Node, key: string): boolean {
  if (node.type === "Property") {
    return key === "key" && !node.computed && node.key.type === "Identifier";
  }
  if (node.type === "MemberExpression") {
    return key === "property" && !node.computed;
  }
  return false;
}

/**
 * Strip Tailwind variant prefixes (`hover:`, `md:`, …) AND a leading `-`
 * (negative offsets like `-inset-1`) so the utility underneath is tested on its
 * own. Variants are colon-delimited; the utility is the LAST `:`-segment.
 */
export function baseClass(token: string): string {
  const idx = token.lastIndexOf(":");
  const bare = idx === -1 ? token : token.slice(idx + 1);
  return bare.startsWith("-") ? bare.slice(1) : bare;
}

/**
 * Named variants that move a utility off the element onto another box: a
 * pseudo-element (`after:h-0.5` sizes the `::after`, not the element) or the
 * element's children (`*:`, `**:`).
 */
const RETARGETING_VARIANTS = new Set([
  "before",
  "after",
  "placeholder",
  "file",
  "marker",
  "selection",
  "first-line",
  "first-letter",
  "backdrop",
  "details-content",
  "*",
  "**",
]);

/** A token's variant prefixes, split on the `:`s outside `[…]` / `(…)`. */
function variantsOf(token: string): string[] {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return variants;
}

/**
 * Does this variant land its utility on another box? A named pseudo-element /
 * child variant, or an arbitrary `[…]` selector that, after its `&`, descends
 * (`>`, `+`, `~`, `_` / space) or names a `::` pseudo-element. A selector
 * BEFORE the `&` (`[.dark_&]`, `[[data-x]+&]`) only conditions the element.
 */
function retargets(variant: string): boolean {
  if (RETARGETING_VARIANTS.has(variant)) return true;
  if (!variant.startsWith("[") || !variant.endsWith("]")) return false;
  const amp = variant.indexOf("&");
  if (amp === -1) return false;
  return /[>+~_\s]|::/.test(variant.slice(amp + 1, -1));
}

/**
 * The utility a token applies to the ELEMENT ITSELF, or `undefined` when a
 * variant retargets it to a pseudo-element or a descendant. `hover:rounded-md`
 * and `md:h-7` are the element's own (a condition, same box); `after:h-0.5`,
 * `*:px-2` and `[&>svg]:size-4` are not.
 *
 * Use this — not {@link baseClass} — when a rule fingerprints the element's
 * own shape (height + padding + radius = a hand-rolled button); keep
 * `baseClass` when a rule judges the utility's VALUE wherever it lands (an
 * `after:rounded-[3px]` is still an ad-hoc radius).
 */
export function ownClass(token: string): string | undefined {
  return variantsOf(token).some(retargets) ? undefined : baseClass(token);
}

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunctionNode(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Is this a class-builder call (`cn(…)`, `cva(…)`, …)? */
function isClassBuilderCall(node: TSESTree.Node): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    CLASS_BUILDERS.has(node.callee.name)
  );
}

/**
 * The expressions a function's CALL evaluates to: an arrow's expression body,
 * or the argument of every `return` in its body — not descending into nested
 * functions, whose returns are theirs, not this function's.
 */
function returnValues(fn: FunctionNode): TSESTree.Node[] {
  if (fn.body.type !== "BlockStatement") return [fn.body];
  const out: TSESTree.Node[] = [];
  const visit = (node: TSESTree.Node): void => {
    if (node.type === "ReturnStatement") {
      if (node.argument) out.push(node.argument);
      return;
    }
    if (isFunctionNode(node)) return;
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            visit(child as TSESTree.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value as TSESTree.Node);
      }
    }
  };
  for (const stmt of fn.body.body) visit(stmt);
  return out;
}

/**
 * The value nodes a same-file identifier stands for, when it is reached from a
 * class context — what the walk continues into in place of the name.
 *
 *   - A `const`/`let` with an initializer stands for that initializer, whatever
 *     its shape: a literal, a map (`SIZE`), a lookup into one (`SIZE[s]`), a
 *     ternary between two, a `satisfies`/`as` wrapper, or a CALL — whose callee
 *     the walk then resolves in turn.
 *   - A FUNCTION (a declaration, or a `const` bound to an arrow / function
 *     expression) stands for its return values. That is what a call of it —
 *     `geometryFor(p, s).box`, `const sz = geometryFor(p, s)` — evaluates to,
 *     so a class table returned through a helper is read like one indexed in
 *     place.
 *   - A class-builder call inside the value (`const cls = cn(…)`,
 *     `const buttonVariants = cva(…)`, a helper returning `cn(…)`) is not
 *     re-entered by the walk — see {@link walkTokens}.
 *   - A parameter or an import has no in-file value and stands for nothing.
 *
 * `seen` guards cycles (a recursive function, `a = b; b = a`) and makes every
 * binding contribute once per walk.
 */
function aliasValues(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
  seen: Set<unknown>,
): TSESTree.Node[] {
  let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node);
  let variable: TSESLint.Scope.Variable | undefined;
  while (scope && !variable) {
    variable = scope.variables.find((v) => v.name === node.name);
    scope = scope.upper;
  }
  if (!variable || seen.has(variable)) return [];
  seen.add(variable);
  const out: TSESTree.Node[] = [];
  for (const def of variable.defs) {
    if (def.type === "FunctionName") {
      // A body-less overload / `declare function` has no value to read.
      if (isFunctionNode(def.node)) out.push(...returnValues(def.node));
      continue;
    }
    const init = def.type === "Variable" ? def.node.init : null;
    if (!init) continue;
    if (isFunctionNode(init)) out.push(...returnValues(init));
    else out.push(init);
  }
  return out;
}

/**
 * The ONE traversal both harvesters run: every class-name token reachable from
 * `node`, handed to `emit` with the node it was read from.
 *
 * Directly contained strings are harvested wherever they sit: bare `Literal`
 * `.value`s and `TemplateElement.value.raw`s (split on whitespace), inside
 * `cn(...)`/`clsx(...)` calls, ternaries, `clsx({ "text-x": cond })` object
 * keys, and arbitrary nesting — the walk is structural, not shape-specific.
 *
 * It ALSO follows same-file aliases (see {@link aliasValues}): an `Identifier`
 * reached from a class context is replaced by the value it stands for. The
 * indirections are load-bearing:
 *
 *   - a MAP indexed in a class context (`cn(TONE[tone])`, `styles.title`) is how
 *     a banned class hides in a style/tone table;
 *   - a standalone string `const` referenced from a class context is how a
 *     banned class hides one hoist away. That hoist is not hypothetical: an
 *     author wrote `const ANCHOR_COLUMN = "block-anchor absolute z-raised"`
 *     specifically because a class literal inline in the JSX would be reported;
 *   - an intermediate local or a helper's RESULT (`const sz =
 *     geometryFor(p, s)` → `SIZE_MAP[size]`) is how a size table hid behind a
 *     function — the avatar's `SIZE_MAP` carried raw font sizes no rule saw.
 *
 * A rule anchored on a position teaches authors where the position isn't, so
 * the walk follows the value instead of guarding the position.
 *
 * A `cva(...)` CALL is walked like any class builder (its base and variant
 * values are literal classes), but a styling-function RESULT — an identifier
 * bound to `cva(...)` and later called — is not followed: the table is checked
 * where it is written. Name slots (object keys, `.property` names) are skipped,
 * never resolved as aliases. Resolution is same-file only. Because the walk
 * only ever starts from a real class-name context, an unrelated doc-string that
 * merely mentions `text-sm` is never inspected.
 */
function walkTokens(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Node | null | undefined,
  emit: (token: string, node: TSESTree.Node) => void,
  seen: Set<unknown>,
  viaAlias = false,
): void {
  if (!node) return;
  // Every class-builder call is a check site of its own. Reached through an
  // alias (`const cls = cond ? cn(…) : …`), its tokens were already reported
  // where the call is written — reporting them again at the use would land on a
  // line the call's own `eslint-disable` does not cover.
  if (viaAlias && isClassBuilderCall(node)) return;
  if (node.type === "Literal") {
    if (typeof node.value === "string") {
      for (const t of node.value.split(/\s+/)) if (t) emit(t, node);
    }
    return;
  }
  if (node.type === "TemplateElement") {
    for (const t of node.value.raw.split(/\s+/)) if (t) emit(t, node);
    return;
  }
  if (node.type === "Identifier") {
    for (const value of aliasValues(sourceCode, node, seen)) {
      walkTokens(sourceCode, value, emit, seen, true);
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || isNameSlot(node, key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walkTokens(sourceCode, child as TSESTree.Node, emit, seen, viaAlias);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walkTokens(sourceCode, value as TSESTree.Node, emit, seen, viaAlias);
    }
  }
}

/**
 * Recursively harvest class-name tokens from a class-value subtree into `out`.
 * See {@link walkTokens} for what is reached and why.
 */
export function collectTokens(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Node | null | undefined,
  out: Set<string>,
  seen: Set<unknown> = new Set(),
): void {
  walkTokens(sourceCode, node, (token) => out.add(token), seen);
}

/** A harvested token paired with the node it came from, for rules that report
 *  the offending node (an autofix target, a specific branch) rather than a name. */
export interface TokenNode {
  token: string;
  node: TSESTree.Node;
}

/**
 * The node-yielding sibling of {@link collectTokens}: same traversal, same
 * alias policy, but each token carries the node it was harvested from.
 *
 * Two rules need this — one autofixes the class it reports, one reports the
 * guarded branch a class sits in. A token reached through an alias is reported
 * at the node it was found in, which is a real location in the same file.
 */
export function collectTokenNodes(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Node | null | undefined,
  out: TokenNode[],
  seen: Set<unknown> = new Set(),
): void {
  walkTokens(
    sourceCode,
    node,
    (token, at) => out.push({ token, node: at }),
    seen,
  );
}

/**
 * What a class rule is handed instead of hand-copying the walk. Rule files
 * import this TYPE (erased by jiti) and receive the values from
 * `buildLintConfig`.
 */
export interface LintToolkit {
  collectTokens: typeof collectTokens;
  collectTokenNodes: typeof collectTokenNodes;
  baseClass: typeof baseClass;
  ownClass: typeof ownClass;
  CLASS_ATTRS: typeof CLASS_ATTRS;
  CLASS_BUILDERS: typeof CLASS_BUILDERS;
  /**
   * Every custom `@utility` class app.css declares, read when the lint config
   * is built (see `declared-utilities.ts`) — so a rule can tell a class that
   * exists from one Tailwind would accept and compile to nothing.
   */
  declaredUtilities: ReadonlySet<string>;
}

/** The toolkit handed to every class-rule factory, over the given stylesheet facts. */
export function createLintToolkit(
  declaredUtilities: ReadonlySet<string>,
): LintToolkit {
  return {
    collectTokens,
    collectTokenNodes,
    baseClass,
    ownClass,
    CLASS_ATTRS,
    CLASS_BUILDERS,
    declaredUtilities,
  };
}

/** A rule module that must be constructed with the shared toolkit. */
export type ClassRuleFactory<TRule> = (toolkit: LintToolkit) => TRule;
