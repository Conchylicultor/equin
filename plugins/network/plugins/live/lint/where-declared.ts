import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

/**
 * where-declared
 *
 * tsc checks a query's `where` for unknown columns only where the object is
 * written: an object literal inside the `useLive` call is excess-checked, one
 * built before it never is (TypeScript has no exact types, and a `where` is
 * all-optional, so a value sharing one column with it passes). An unknown
 * column there compiles, then throws on render ("… is not a filterable
 * column") — on a rarely taken branch, rarely.
 *
 * So a `where` built outside the call is declared with its collection's
 * where type, where tsc's own excess-property check fires:
 *
 *   const w: LiveWhereOf<typeof tasks> = { status: "open" };
 *   useLive(tasks, { where: w });
 *
 * Flags a `useLive` / `useOptimisticResource` call whose query's `where` (on
 * any branch of it, and through a query built before the call) has the type
 * of an object literal written outside the call — the type tsc inferred for
 * an undeclared `const`, a function's return, a pre-built query. A declared
 * type (`LiveWhereOf<…>`, `LiveWhere<F>`), a filter tree from `or()` /
 * `and()`, and a literal written in the call pass.
 */

const READS = new Set(["useLive", "useOptimisticResource"]);

/** The object-literal declaration a type was inferred from, or null. */
function literalOf(type: ts.Type): ts.Node | null {
  const symbol = type.getSymbol();
  if (
    symbol === undefined ||
    (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0
  )
    return null;
  return symbol.declarations?.[0] ?? null;
}

function within(node: ts.Node, outer: ts.Node): boolean {
  return (
    node.getSourceFile() === outer.getSourceFile() &&
    node.pos >= outer.pos &&
    node.end <= outer.end
  );
}

export default createRule({
  name: "where-declared",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a `where` built outside its `useLive` call to be declared with its collection's where type (`LiveWhereOf<typeof c>`), so tsc checks its columns.",
      requiresTypeChecking: true,
    },
    messages: {
      undeclared:
        "This `where` is built outside the `{{name}}` call, where tsc never checks it for unknown columns (they would throw on render). Declare it with its collection's where type: `const w: LiveWhereOf<typeof c> = { … }`.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          !READS.has(node.callee.name) ||
          node.arguments.length < 2
        ) {
          return;
        }
        const { program, esTreeNodeToTSNodeMap } =
          ESLintUtils.getParserServices(context);
        const checker = program.getTypeChecker();
        const arg = esTreeNodeToTSNodeMap.get(node.arguments[1]!);
        const query = checker.getTypeAtLocation(arg);
        for (const branch of query.isUnion() ? query.types : [query]) {
          const where = branch.getProperty("where");
          if (where === undefined) continue;
          const type = checker.getTypeOfSymbolAtLocation(where, arg);
          for (const part of type.isUnion() ? type.types : [type]) {
            const literal = literalOf(part);
            if (literal !== null && !within(literal, arg)) {
              context.report({
                node: node.arguments[1]!,
                messageId: "undeclared",
                data: { name: node.callee.name },
              });
              return;
            }
          }
        }
      },
    };
  },
});
