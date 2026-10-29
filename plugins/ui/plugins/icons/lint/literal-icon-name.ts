import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import { isIconRefModule } from "../core";

const createRule = lintRuleCreator(import.meta.url);

const MARKERS = new Set(["symbol", "brand", "seti"]);

/**
 * `symbol(…)` / `brand(…)` / `seti(…)` take a string literal, called by their own name.
 *
 * The icon manifest — the names the sprites ship — is collected from source
 * text at build time. A name the scan cannot read (`symbol(name)`, an aliased
 * import, `names.map(symbol)`, `icons.symbol(…)`) would ship no sprite symbol
 * and draw an empty box. So every spelling the scan cannot see is an error
 * here, and a hand-built `{ kind: "symbol", name }` is not an `IconRef`'s only
 * other road: the type is structural, but the manifest is not.
 */
export default createRule({
  name: "literal-icon-name",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a string-literal argument to symbol() / brand() / seti() from the icons core, imported under its own name and only ever called.",
    },
    schema: [],
    messages: {
      notLiteral:
        "`{{name}}(…)` takes a string literal: the build collects icon names from source text, so a computed name ships no sprite symbol.",
      aliased:
        'Import `{{name}}` under its own name — the icon manifest scan looks for `{{name}}("…")` calls.',
      namespace:
        "Import `symbol` / `brand` / `seti` by name, not through a namespace — the icon manifest scan cannot see `ns.symbol(…)`.",
      notCalled:
        "`{{name}}` may only be called directly with a string literal; passing it around hides the icon name from the manifest scan.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (!isIconRefModule(context.filename, node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            context.report({ node: spec, messageId: "namespace" });
            continue;
          }
          if (spec.type !== "ImportSpecifier") continue;
          if (spec.importKind === "type") continue;
          const imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          if (!MARKERS.has(imported)) continue;
          if (spec.local.name !== imported) {
            context.report({
              node: spec,
              messageId: "aliased",
              data: { name: imported },
            });
            continue;
          }
          const variable = context.sourceCode
            .getDeclaredVariables(spec)
            .find((v) => v.name === imported);
          for (const ref of variable?.references ?? []) {
            const id = ref.identifier;
            const parent = id.parent;
            if (parent?.type !== "CallExpression" || parent.callee !== id) {
              context.report({
                node: id,
                messageId: "notCalled",
                data: { name: imported },
              });
              continue;
            }
            const [arg, ...rest] = parent.arguments;
            const literal =
              arg !== undefined &&
              rest.length === 0 &&
              arg.type === "Literal" &&
              typeof arg.value === "string";
            if (!literal) {
              context.report({
                node: parent,
                messageId: "notLiteral",
                data: { name: imported },
              });
            }
          }
        }
      },
    };
  },
});
