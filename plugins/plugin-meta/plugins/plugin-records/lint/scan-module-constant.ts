import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The node a value expression stands for once `satisfies` / `as` wrappers are peeled. */
function outerValue(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.parent &&
    (n.parent.type === "TSSatisfiesExpression" ||
      n.parent.type === "TSAsExpression") &&
    n.parent.expression === n
  )
    n = n.parent;
  return n;
}

/**
 * Whether `meta` (an `import.meta.url`) is the `url` of an object literal
 * that is the whole initializer of a top-level exported `const`.
 */
function isModuleConstantUrl(meta: TSESTree.MemberExpression): boolean {
  const prop = meta.parent;
  if (
    prop?.type !== "Property" ||
    prop.value !== meta ||
    prop.computed ||
    prop.key.type !== "Identifier" ||
    prop.key.name !== "url"
  )
    return false;
  const object = prop.parent;
  if (object?.type !== "ObjectExpression") return false;
  const declarator = outerValue(object).parent;
  if (declarator?.type !== "VariableDeclarator") return false;
  const declaration = declarator.parent;
  return (
    declaration?.type === "VariableDeclaration" &&
    declaration.kind === "const" &&
    declaration.parent?.type === "ExportNamedDeclaration" &&
    declaration.parent.parent?.type === "Program"
  );
}

/**
 * A file scan or fold (plugin-records' `FileScan` / `FileFold`, defined in a
 * `*.scan.ts` module) is a top-level exported constant — never built by a
 * function. Its records are keyed by its module's closure and the npm code
 * that closure imports (`npmCodeKey`); a scan built by a factory can close
 * over what its caller hands it (a `typescript` module, a parser), code no
 * import of its closure names — so a bump of that package would leave every
 * record standing under a key it no longer answers for. A scan that needs a
 * package imports it; its consumer loads the scan module lazily when the
 * package's eval cost matters.
 */
export default createRule({
  name: "scan-module-constant",
  meta: {
    type: "problem",
    docs: {
      description:
        "In a *.scan.ts module, `import.meta.url` is only the `url` of a top-level exported constant scan or fold.",
    },
    schema: [],
    messages: {
      notConstant:
        "A file scan / fold is a top-level `export const x: FileScan<…> = { url: import.meta.url, … }`, never built by a function: its records are keyed by the npm code its module imports, so anything its caller hands it (a `typescript` module) would run unkeyed. Import the package in this module, and have the consumer `await import()` it if its load cost matters.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!context.filename.endsWith(".scan.ts")) return {};
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        if (
          node.object.type !== "MetaProperty" ||
          node.object.meta.name !== "import" ||
          node.property.type !== "Identifier" ||
          node.property.name !== "url"
        )
          return;
        if (!isModuleConstantUrl(node))
          context.report({ node, messageId: "notConstant" });
      },
    };
  },
});
