import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type * as ts from "typescript";
import { HOOK_NAME, holdsHook, keyName, typeMembers } from "./hook-brand";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * A binding that holds a `Hook<…>` must be named `use*`.
 *
 * The React Compiler and `rules-of-hooks` recognise a hook by its NAME alone.
 * A hook bound under any other name — `const resolve = props.useResolve`,
 * `const { useResolve: resolve } = p`, a prop declared `resolve: Hook<…>` — is
 * called as a plain function, which the compiler memoizes on its arguments. On
 * a cache hit the hook's own hooks are skipped, the next hook lands on the
 * wrong slot, and React throws #311. Only the TYPE knows the value is a hook;
 * `Hook<F>` makes that visible, and this rule reads it.
 *
 * Checked bindings: variable declarators, destructured bindings (renames
 * included), function/arrow/method parameters, interface / type-literal
 * property signatures, and class properties. Object-literal keys are NOT
 * checked — their names are dictated by the target type, whose declaration this
 * rule already checks.
 *
 * The risk only runs one way: a plain function under a `use*` name merely costs
 * some caching, so names that already match are never asked about.
 */
export default createRule({
  name: "hook-binding-name",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every binding whose type is Hook<…> to be named use* — the React Compiler recognises hooks by name only and memoizes any other call, skipping the hook's own hooks on a cache hit (React #311).",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      hookBindingName:
        "`{{name}}` holds a hook (Hook<…>) — name it use* (e.g. `use{{suggest}}`). The React Compiler and rules-of-hooks recognise hooks by name only: a hook called as `{{name}}(…)` is memoized like a pure function, its own hooks are skipped on a cache hit, and React throws #311.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const report = (node: TSESTree.Node, name: string) =>
      context.report({
        node,
        messageId: "hookBindingName",
        data: {
          name,
          suggest: name
            .replace(/^_+/, "")
            .replace(/^./, (c) => c.toUpperCase()),
        },
      });

    const checkIdentifier = (id: TSESTree.Identifier) => {
      if (HOOK_NAME.test(id.name)) return;
      if (holdsHook(services.getTypeAtLocation(id))) report(id, id.name);
    };

    /**
     * Whether the value an expression produces may be a hook, looking through
     * the operators that pick one of several operands. Needed because the
     * binding's own type can LOSE the brand: `props.useX ?? plainFn` is the
     * union `Hook<F> | F`, and TypeScript's subtype reduction collapses it to
     * `F` (the two are mutually assignable, the brand being optional) — which
     * is exactly the fallback shape a rename is born in.
     */
    const exprHoldsHook = (expr: TSESTree.Expression): boolean => {
      if (expr.type === "LogicalExpression")
        return exprHoldsHook(expr.left) || exprHoldsHook(expr.right);
      if (expr.type === "ConditionalExpression")
        return exprHoldsHook(expr.consequent) || exprHoldsHook(expr.alternate);
      if (
        expr.type === "TSAsExpression" ||
        expr.type === "TSSatisfiesExpression" ||
        expr.type === "TSNonNullExpression" ||
        expr.type === "ChainExpression"
      )
        return exprHoldsHook(expr.expression);
      return holdsHook(services.getTypeAtLocation(expr));
    };

    /** A plain name bound straight to an initializer: check the operands too. */
    const checkInitialized = (
      id: TSESTree.Node,
      init: TSESTree.Expression | null | undefined,
    ) => {
      if (id.type !== "Identifier" || HOOK_NAME.test(id.name)) return;
      if (init && exprHoldsHook(init)) report(id, id.name);
      else checkIdentifier(id);
    };

    /**
     * Every name a declaration pattern binds: a plain name, each leaf of an
     * object/array destructure (a rename checks its LOCAL name), a default's
     * target (with the default as an operand), a rest element, and a
     * constructor parameter property.
     */
    const checkPattern = (node: TSESTree.Node | null): void => {
      if (!node) return;
      if (node.type === "Identifier") checkIdentifier(node);
      else if (node.type === "ObjectPattern") {
        for (const p of node.properties) {
          if (
            p.type === "Property" &&
            !p.computed &&
            sourceFieldIsHook(node, p)
          )
            continue;
          checkPattern(p.type === "Property" ? p.value : p);
        }
      } else if (node.type === "ArrayPattern")
        node.elements.forEach(checkPattern);
      else if (node.type === "AssignmentPattern") {
        if (node.left.type === "Identifier")
          checkInitialized(node.left, node.right);
        else checkPattern(node.left);
      } else if (node.type === "RestElement") checkPattern(node.argument);
      else if (node.type === "TSParameterProperty")
        checkPattern(node.parameter);
    };

    /**
     * A destructured field read from the SOURCE's declared field type — the
     * local binding's own type can lose the brand once a default joins it
     * (`{ useX: x = plainFn }` reduces like `??` does). Reports and returns
     * true when the source field is a hook and the local name is not use*.
     */
    const sourceFieldIsHook = (
      pattern: TSESTree.ObjectPattern,
      p: TSESTree.Property,
    ): boolean => {
      const local =
        p.value.type === "AssignmentPattern" ? p.value.left : p.value;
      if (local.type !== "Identifier" || HOOK_NAME.test(local.name))
        return false;
      const field = keyName(p.key);
      if (field === undefined) return false;
      const at = services.esTreeNodeToTSNodeMap.get(pattern);
      const isHook = typeMembers(services.getTypeAtLocation(pattern)).some(
        (m) => {
          const sym = m.getProperty(field);
          return (
            sym !== undefined &&
            holdsHook(checker.getTypeOfSymbolAtLocation(sym, at))
          );
        },
      );
      if (!isHook) return false;
      report(local, local.name);
      return true;
    };

    const checkParams = (params: TSESTree.Parameter[]) =>
      params.forEach(checkPattern);

    return {
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        if (node.id.type === "Identifier") checkInitialized(node.id, node.init);
        else checkPattern(node.id);
      },
      FunctionDeclaration: (node) => checkParams(node.params),
      FunctionExpression: (node) => checkParams(node.params),
      ArrowFunctionExpression: (node) => checkParams(node.params),
      TSPropertySignature(node: TSESTree.TSPropertySignature) {
        if (node.computed) return;
        const name = keyName(node.key);
        if (name === undefined || HOOK_NAME.test(name)) return;
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (!annotation) return;
        const tsType = services.esTreeNodeToTSNodeMap.get(
          annotation,
        ) as ts.TypeNode;
        if (holdsHook(checker.getTypeFromTypeNode(tsType)))
          report(node.key, name);
      },
      PropertyDefinition(node: TSESTree.PropertyDefinition) {
        if (node.computed) return;
        const name = keyName(node.key);
        if (name === undefined || HOOK_NAME.test(name)) return;
        if (holdsHook(services.getTypeAtLocation(node.key)))
          report(node.key, name);
      },
    };
  },
});
