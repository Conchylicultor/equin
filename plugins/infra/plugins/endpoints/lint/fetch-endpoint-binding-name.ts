import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * fetch-endpoint-binding-name
 *
 * The endpoint client is a value bound to a transport (`FetchEndpoint`): a
 * component gets it from `useFetchEndpoint()`, page-level code from
 * `fetchEndpointOver(t)`, a helper from its caller. The call-name lint rules
 * that guard its use (`endpoints/no-void-fetch-endpoint`,
 * `live/no-endpoint-read`, `page-editor/no-adhoc-structural-write`,
 * `reactive-server-io/no-reactive-server-io`, …) recognise a call by the NAME
 * `fetchEndpoint`, so every binding of the client must carry that name — a
 * renamed one would escape all of them. This rule keeps it so:
 *
 * - a `useFetchEndpoint()` / `fetchEndpointOver(…)` result is bound directly as
 *   `const fetchEndpoint = …` (or a `fetchEndpoint:` property) — never called
 *   inline, returned, or bound under another name;
 * - a parameter, variable, property or field typed `FetchEndpoint` is named
 *   `fetchEndpoint`;
 * - a `fetchEndpoint` binding is never aliased (`const f = fetchEndpoint`,
 *   `{ fetchEndpoint: f }`, `{ f: fetchEndpoint }`).
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

const NAME = "fetchEndpoint";
const MAKERS = new Set(["useFetchEndpoint", "fetchEndpointOver"]);
const TYPE_NAME = "FetchEndpoint";

function keyName(key: TSESTree.Node, computed: boolean): string | null {
  if (key.type === "Identifier" && !computed) return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** Whether a type annotation is `FetchEndpoint` (or a union holding it). */
function namesFetchEndpoint(type: TSESTree.TypeNode): boolean {
  if (type.type === "TSTypeReference")
    return (
      type.typeName.type === "Identifier" && type.typeName.name === TYPE_NAME
    );
  if (type.type === "TSUnionType") return type.types.some(namesFetchEndpoint);
  return false;
}

export default createRule({
  name: "fetch-endpoint-binding-name",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every binding of the transport-bound endpoint client (FetchEndpoint) to be named `fetchEndpoint`, so the call-name lint rules see every call.",
    },
    schema: [],
    messages: {
      makerBinding:
        "Bind `{{maker}}(…)` directly as `const fetchEndpoint = {{maker}}(…)`: " +
        "the lint rules guarding endpoint calls (no-void-fetch-endpoint, " +
        "no-endpoint-read, no-reactive-server-io, …) recognise a call by the " +
        "name `fetchEndpoint`, so a client called inline, returned or bound " +
        "under another name escapes them.",
      typedBinding:
        "A `FetchEndpoint` binding must be named `fetchEndpoint` (not " +
        "`{{name}}`): the lint rules guarding endpoint calls recognise a call " +
        "by that name.",
      alias:
        "Do not alias the endpoint client (`{{name}}`): keep the name " +
        "`fetchEndpoint`, which the lint rules guarding endpoint calls " +
        "recognise.",
    },
  },
  defaultOptions: [],
  create(context) {
    const checkTyped = (
      node: TSESTree.Node,
      name: string | null,
      annotation: TSESTree.TSTypeAnnotation | undefined,
    ) => {
      if (
        annotation === undefined ||
        !namesFetchEndpoint(annotation.typeAnnotation)
      )
        return;
      if (name !== NAME)
        context.report({
          node,
          messageId: "typedBinding",
          data: { name: name ?? "<computed>" },
        });
    };

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !MAKERS.has(node.callee.name))
          return;
        const parent = node.parent;
        const bound =
          (parent.type === "VariableDeclarator" &&
            parent.init === node &&
            parent.id.type === "Identifier" &&
            parent.id.name === NAME) ||
          (parent.type === "Property" &&
            parent.value === node &&
            keyName(parent.key, parent.computed) === NAME);
        if (!bound)
          context.report({
            node,
            messageId: "makerBinding",
            data: { maker: node.callee.name },
          });
      },

      Identifier(node) {
        // A typed parameter / variable: `(f: FetchEndpoint)`, `let f: FetchEndpoint`.
        if (node.typeAnnotation !== undefined)
          checkTyped(node, node.name, node.typeAnnotation);
        if (node.name !== NAME) return;
        const parent = node.parent;
        // `const f = fetchEndpoint`
        if (
          parent.type === "VariableDeclarator" &&
          parent.init === node &&
          !(parent.id.type === "Identifier" && parent.id.name === NAME)
        )
          context.report({
            node: parent,
            messageId: "alias",
            data: {
              name:
                parent.id.type === "Identifier" ? parent.id.name : "a pattern",
            },
          });
        // `{ f: fetchEndpoint }` (an object literal, not a pattern)
        if (
          parent.type === "Property" &&
          parent.value === node &&
          parent.parent.type === "ObjectExpression" &&
          keyName(parent.key, parent.computed) !== NAME
        )
          context.report({
            node: parent,
            messageId: "alias",
            data: {
              name: keyName(parent.key, parent.computed) ?? "<computed>",
            },
          });
      },

      // `const { fetchEndpoint: f } = deps` / `({ fetchEndpoint: f }) => …`
      Property(node) {
        if (node.parent.type !== "ObjectPattern") return;
        if (keyName(node.key, node.computed) !== NAME) return;
        const value =
          node.value.type === "AssignmentPattern"
            ? node.value.left
            : node.value;
        if (value.type === "Identifier" && value.name !== NAME)
          context.report({
            node,
            messageId: "alias",
            data: { name: value.name },
          });
      },

      TSPropertySignature(node) {
        checkTyped(node, keyName(node.key, node.computed), node.typeAnnotation);
      },

      PropertyDefinition(node) {
        checkTyped(node, keyName(node.key, node.computed), node.typeAnnotation);
      },
    };
  },
});
