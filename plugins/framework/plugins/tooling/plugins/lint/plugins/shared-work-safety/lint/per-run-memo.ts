import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

/** What a run's file set answers (`RepoFiles`, tooling/core), read structurally. */
const FILE_SET_MEMBERS = ["root", "all", "has", "under", "read"] as const;

/**
 * per-run-memo
 *
 * A memo keyed by a run's file set — a `RepoFiles`, or a value holding one
 * (`CodegenPass.repo`) — holds work every check of the run reuses: whichever
 * check asks first starts it. Unless it runs as SHARED work
 * (`packages/shared-work`), that check's own meter (its file calls, judged
 * against its `wholeTreeRead` declaration) is charged for the whole tree, and
 * the verdict depends on the order checks happened to run in. Written by
 * hand, the scope is one forgotten wrap away (`serverPortabilityOf` had none);
 * `sharedMemo(name, produce, { owner })` runs the producer in it by
 * construction — and as the asking check's own work when the set is that
 * check's own (an input-keyed check's recording set).
 *
 * So a module-level `new Map(…)` / `new WeakMap(…)` whose key type is a file
 * set (or holds one under `repo`) is refused. Type-aware: the key type is
 * read off the constructed map's type, explicit or inferred.
 */
export default createRule({
  name: "per-run-memo",
  meta: {
    type: "problem",
    docs: {
      description:
        "A module-level Map / WeakMap keyed by a run's file set is a sharedMemo, so the work it memoizes is shared work and no check is charged for asking first.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      handRolled:
        "A module-level {{map}} keyed by a run's file set ({{key}}) is a per-run memo: its work is every check's, started by whichever asks first. Spell it `sharedMemo(name, produce, { owner })` from \"@plugins/packages/plugins/shared-work/core\", which runs the producer as shared work (or as the check's own over its own recording set).",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const isFileSet = (type: ts.Type): boolean =>
      FILE_SET_MEMBERS.every((m) => type.getProperty(m) !== undefined);
    const holdsFileSet = (type: ts.Type, at: ts.Node): boolean => {
      if (isFileSet(type)) return true;
      const repo = type.getProperty("repo");
      return (
        repo !== undefined &&
        isFileSet(checker.getTypeOfSymbolAtLocation(repo, at))
      );
    };

    return {
      NewExpression(node: TSESTree.NewExpression) {
        if (
          node.callee.type !== "Identifier" ||
          (node.callee.name !== "Map" && node.callee.name !== "WeakMap")
        )
          return;
        if (!atModuleScope(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const type = checker.getTypeAtLocation(tsNode);
        const [key] = checker.getTypeArguments(type as ts.TypeReference);
        if (key === undefined || !holdsFileSet(key, tsNode)) return;
        context.report({
          node,
          messageId: "handRolled",
          data: { map: node.callee.name, key: checker.typeToString(key) },
        });
      },
    };
  },
});

/** A `new …` that initializes a module-level binding (`const x = new Map()`, exported or not). */
function atModuleScope(node: TSESTree.NewExpression): boolean {
  const declarator = node.parent;
  if (declarator?.type !== "VariableDeclarator" || declarator.init !== node)
    return false;
  const declaration = declarator.parent;
  const holder = declaration?.parent;
  return (
    holder?.type === "Program" ||
    (holder?.type === "ExportNamedDeclaration" &&
      holder.parent?.type === "Program")
  );
}
