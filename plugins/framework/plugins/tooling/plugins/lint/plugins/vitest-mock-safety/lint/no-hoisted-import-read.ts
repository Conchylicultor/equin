import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { isFunction, viMethodOf } from "./vi-call";

const createRule = lintRuleCreator(import.meta.url);

// vitest hoists every `vi.mock(…)` and `vi.hoisted(…)` above the file's
// imports, which it turns into `const __vi_import_N__ = await import(…)` in
// source order. A hoisted callback that reads an imported binding therefore
// reads it before it exists — `Cannot access '__vi_import_5__' before
// initialization` — or, for a mock factory run lazily, only while the import
// order happens to favour it. The file reads top-down as if the import came
// first, so nothing but a run shows it (app-boot-screen and app-load-errors
// died this way after a rename moved a constant into an import). Load it
// INSIDE the callback instead: `await vi.hoisted(async () => { const { X } =
// await vi.importActual<typeof Mod>("…"); … })` with a top-level
// `import type * as Mod from "…"` (an inline `import("@plugins/…")` is refused
// by plugin-boundaries R9), or a literal. Type-only reads are erased and fine;
// `vi` itself is hoisted with vitest's own import. A read inside a function the
// callback merely DEFINES (a mocked component rendering an imported one) runs
// later, once imports exist, and is fine — only what the callback evaluates
// when it runs is checked.
export default createRule({
  name: "no-hoisted-import-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hoisted vi.mock / vi.hoisted callback from reading a binding the file imports — it runs before that import.",
    },
    schema: [],
    messages: {
      hoistedImportRead:
        "`{{name}}` is imported by this file, but `vi.{{method}}` is hoisted above every import, so " +
        "this callback runs before `{{name}}` exists. Load it inside the callback " +
        '(`const { {{name}} } = await vi.importActual<typeof Mod>("…")` in an async `vi.hoisted`/factory, ' +
        "with a top-level `import type * as Mod`) or use a literal.",
    },
  },
  defaultOptions: [],
  create(context) {
    const hoisted: {
      fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;
      method: string;
    }[] = [];
    return {
      CallExpression(node) {
        const method = viMethodOf(node);
        const fn =
          method === "hoisted"
            ? node.arguments[0]
            : method === "mock"
              ? node.arguments[1]
              : undefined;
        if (method && isFunction(fn)) hoisted.push({ fn, method });
      },
      "Program:exit"(program) {
        if (hoisted.length === 0) return;
        const moduleScope = context.sourceCode
          .getScope(program)
          .childScopes.find((s) => s.type === "module");
        if (!moduleScope) return;
        for (const variable of moduleScope.variables) {
          const def = variable.defs[0];
          if (def?.type !== "ImportBinding") continue;
          const decl = def.parent;
          if (
            decl.type !== AST_NODE_TYPES.ImportDeclaration ||
            decl.importKind === "type" ||
            decl.source.value === "vitest" ||
            (def.node.type === AST_NODE_TYPES.ImportSpecifier &&
              def.node.importKind === "type")
          )
            continue;
          for (const ref of variable.references) {
            if (!ref.isValueReference) continue;
            const runsIn = ref.from.variableScope.block;
            const site = hoisted.find(({ fn }) => fn === runsIn);
            if (site)
              context.report({
                node: ref.identifier,
                messageId: "hoistedImportRead",
                data: { name: variable.name, method: site.method },
              });
          }
        }
      },
    };
  },
});
