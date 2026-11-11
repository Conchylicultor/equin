import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

/**
 * What counts as a DOM read — the one detector `no-module-scope-dom` and
 * `no-render-time-dom` share, so the two cannot disagree on it. Each rule then
 * decides only WHEN a read is a problem (module evaluation / render).
 */

/** Browser-only globals: reading any of them throws in a runtime without a DOM. */
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "matchMedia",
  "location",
  "history",
  "screen",
  "getComputedStyle",
  "Element",
  "Node",
]);
/** The DOM classes (`HTMLElement`, `SVGSVGElement`, …) an `instanceof` or `extends` reads. */
const DOM_CLASS = /^(?:HTML|SVG)\w*Element$/;

export function isBrowserGlobal(name: string): boolean {
  return BROWSER_GLOBALS.has(name) || DOM_CLASS.test(name);
}

export interface DomRead {
  /** A JSX tag (`<Node />`) is a value read too. */
  readonly identifier: TSESTree.Identifier | TSESTree.JSXIdentifier;
  readonly name: string;
  /** The scope the read happens in (where a rule asks "does this run now?"). */
  readonly from: TSESLint.Scope.Scope;
}

/**
 * Every runtime read of a browser global in the file. Covers:
 *
 * - a name the file never declares (`globalScope.through`), and a name the
 *   lint config declares as a global (it resolves to a definition-less
 *   variable, so it is NOT in `through`);
 * - a read wrapped in a TypeScript cast — `(window as X).foo`, `document!`,
 *   `<X>navigator`, `window satisfies X` — which is still a value read;
 *
 * and skips what emits no runtime read: a type position (`x as HTMLElement`'s
 * class, `typeof window` in a type) and the operand of a `typeof` expression.
 */
export function domReads(sourceCode: TSESLint.SourceCode): DomRead[] {
  const globalScope = sourceCode.scopeManager?.globalScope;
  if (!globalScope) return [];
  const refs = [
    ...globalScope.through,
    ...globalScope.variables
      .filter((v) => v.defs.length === 0)
      .flatMap((v) => v.references),
  ];
  const reads: DomRead[] = [];
  for (const ref of refs) {
    const identifier = ref.identifier as
      TSESTree.Identifier | TSESTree.JSXIdentifier;
    const name = identifier.name;
    if (!isBrowserGlobal(name)) continue;
    if (!ref.isValueReference) continue;
    if (isInTypeQuery(identifier)) continue;
    if (isTypeofOperand(identifier)) continue;
    reads.push({ identifier, name, from: ref.from });
  }
  return reads;
}

/** TypeScript wrappers that change a value's type, never the value. */
const TS_VALUE_WRAPPERS = new Set<string>([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSSatisfiesExpression",
]);

/** `e` with every cast around it peeled: `(window as X)!` → `window`. */
export function unwrapTsCasts(e: TSESTree.Node): TSESTree.Node {
  let n = e;
  while (TS_VALUE_WRAPPERS.has(n.type))
    n = (n as TSESTree.TSAsExpression).expression;
  return n;
}

/** `typeof window`, also through casts: `typeof (window as X)`. */
function isTypeofOperand(identifier: TSESTree.Node): boolean {
  let p = identifier.parent;
  while (p && TS_VALUE_WRAPPERS.has(p.type)) p = p.parent;
  return p?.type === "UnaryExpression" && p.operator === "typeof";
}

function isInTypeQuery(identifier: TSESTree.Node): boolean {
  for (let a: TSESTree.Node | undefined = identifier.parent; a; a = a.parent)
    if (a.type === "TSTypeQuery") return true;
  return false;
}
