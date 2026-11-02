/**
 * "Is this identifier a resource result?" — the syntactic answer the
 * `status`-model rules (`no-ready-negation`) share. A binding counts when it is
 * initialized from a read that returns a `ResourceResult`-shaped union, or is a
 * parameter annotated with one of those types; a `status` destructured from
 * such a read counts too.
 */
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";

/** Reads whose result has the `loading | error | ready` `status` union. */
const RESULT_READS = new Set([
  "useResource",
  "useLive",
  "combineResources",
  "useCombinedResources",
  "useConfigResult",
  "mapResource",
  "useOptimisticResource",
]);

/** Type names whose values carry the `status` union. */
const RESULT_TYPES = new Set([
  "ResourceResult",
  "LiveListResult",
  "LiveRowResult",
  "CombinedResources",
  "ResourceReadiness",
  "OptimisticResult",
]);

type AnyContext = Readonly<TSESLint.RuleContext<string, readonly unknown[]>>;

function resolveVariable(
  context: AnyContext,
  ident: TSESTree.Identifier,
): TSESLint.Scope.Variable | null {
  let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(ident);
  while (scope) {
    const v = scope.variables.find((v) => v.name === ident.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}

function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === AST_NODE_TYPES.TSAsExpression ||
    n.type === AST_NODE_TYPES.TSTypeAssertion ||
    n.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    n = n.expression;
  }
  return n;
}

function isResultRead(init: TSESTree.Expression | null | undefined): boolean {
  if (!init) return false;
  const call = unwrap(init);
  if (call.type !== AST_NODE_TYPES.CallExpression) return false;
  const callee = call.callee;
  const name =
    callee.type === AST_NODE_TYPES.Identifier
      ? callee.name
      : callee.type === AST_NODE_TYPES.MemberExpression &&
          callee.property.type === AST_NODE_TYPES.Identifier
        ? callee.property.name
        : null;
  return name !== null && RESULT_READS.has(name);
}

function isResultType(annotation: TSESTree.TypeNode | undefined): boolean {
  if (!annotation) return false;
  if (annotation.type === AST_NODE_TYPES.TSTypeReference) {
    const name = annotation.typeName;
    const id =
      name.type === AST_NODE_TYPES.Identifier
        ? name.name
        : name.type === AST_NODE_TYPES.TSQualifiedName
          ? name.right.name
          : null;
    return id !== null && RESULT_TYPES.has(id);
  }
  if (annotation.type === AST_NODE_TYPES.TSUnionType) {
    return annotation.types.some((t) => isResultType(t));
  }
  return false;
}

/** Is `ident` a resource-result binding (see the file header)? */
export function isResultBinding(
  context: AnyContext,
  ident: TSESTree.Identifier,
): boolean {
  const def = resolveVariable(context, ident)?.defs[0];
  if (!def) return false;
  if (def.node.type === AST_NODE_TYPES.VariableDeclarator) {
    return def.node.id === def.name && isResultRead(def.node.init);
  }
  if (def.type === "Parameter") {
    const name = def.name as TSESTree.Identifier;
    return isResultType(name.typeAnnotation?.typeAnnotation);
  }
  return false;
}

/**
 * Is `ident` a `status` destructured from a result read
 * (`const { status } = useLive(c)`)?
 */
export function isDestructuredStatus(
  context: AnyContext,
  ident: TSESTree.Identifier,
): boolean {
  const def = resolveVariable(context, ident)?.defs[0];
  if (!def || def.node.type !== AST_NODE_TYPES.VariableDeclarator) return false;
  const pattern = def.node.id;
  if (pattern.type !== AST_NODE_TYPES.ObjectPattern) return false;
  if (!isResultRead(def.node.init)) return false;
  return pattern.properties.some(
    (p) =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      p.key.name === "status" &&
      p.value === def.name,
  );
}

/** Is this file test code (named `*.test.*`, under `__tests__/` or a `testing/` barrel)? */
export function isTestFile(filename: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(filename) ||
    filename.includes("/__tests__/") ||
    /\/(web|server|core|central|shared)\/testing\//.test(filename)
  );
}
