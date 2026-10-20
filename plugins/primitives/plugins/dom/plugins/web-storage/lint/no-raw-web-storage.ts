import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://internal/lint/web-storage/${name}`,
);

const STORAGE_GLOBALS = new Set(["localStorage", "sessionStorage"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

/** TS type positions (`typeof localStorage` in a type) emit no runtime access. */
function isInTypePosition(node: TSESTree.Node): boolean {
  for (let p = node.parent; p; p = p.parent)
    if (p.type.startsWith("TS")) return true;
  return false;
}

export default createRule({
  name: "no-raw-web-storage",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow touching localStorage / sessionStorage outside the web-storage primitive.",
    },
    schema: [],
    messages: {
      raw:
        "`{{name}}` is shared by every plugin of the origin, has a hard ~10 MB quota and no owner: one plugin filling it breaks every other plugin's writes (2026-10-19, every draft lost). " +
        "Declare a store with `defineStore({ owner, label, area, cap, ttl, whenFull, schema })` from " +
        "@plugins/primitives/plugins/dom/plugins/web-storage/web (or, for a draft the user types, persistent-draft over such a store) and read/write through it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "Program:exit"(): void {
        const globalScope = context.sourceCode.scopeManager?.globalScope;
        if (!globalScope) return;
        for (const ref of globalScope.through) {
          const id = ref.identifier as TSESTree.Identifier;
          const name = id.name;
          if (isInTypePosition(id)) continue;
          if (STORAGE_GLOBALS.has(name)) {
            context.report({ node: id, messageId: "raw", data: { name } });
            continue;
          }
          // `window.localStorage`, `globalThis.sessionStorage`.
          const parent = id.parent;
          if (
            GLOBAL_OBJECTS.has(name) &&
            parent?.type === "MemberExpression" &&
            parent.object === id &&
            !parent.computed &&
            parent.property.type === "Identifier" &&
            STORAGE_GLOBALS.has(parent.property.name)
          ) {
            context.report({
              node: parent,
              messageId: "raw",
              data: { name: parent.property.name },
            });
          }
        }
      },
    };
  },
});
