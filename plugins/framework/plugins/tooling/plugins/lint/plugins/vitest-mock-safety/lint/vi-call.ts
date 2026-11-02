import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

/** `vi.<method>(…)` — by name: vitest's `vi` is the one spelling either rule
 *  keys on (it is how vitest's own hoisting transform finds the calls). */
export function viMethodOf(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    callee.object.name !== "vi" ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  )
    return null;
  return callee.property.name;
}

export function isFunction(
  node: TSESTree.Node | undefined,
): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression {
  return (
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionExpression
  );
}
